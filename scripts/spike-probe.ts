// Spikes S5 and S6 (spec 11.1, 14, 16.3): shared-pool registration ordering between the Batman
// project and the probe project, S5 (send to an unregistered number), S6 (two-way probe <-> Batman).
//
// Run:  npx tsx scripts/spike-probe.ts list   # read-only: list users on both projects
//       npx tsx scripts/spike-probe.ts run    # register (idempotent), S5, write .env if reciprocal, S6 x3
//       npx tsx scripts/spike-probe.ts cleanup [--yes]  # dry run: list pool-number users to delete
//       (or: pnpm spike probe run)
//
// Safety:
// - Loads .env itself and never prints secrets. Every phone number is redacted to the last 4 digits.
// - Only sends to pool numbers returned as assignedPhoneNumber by the Batman or probe project.
//   Refuses to register or message HUMAN_IPHONE_E164 or TEST_GUARDIAN_E164.
// - Never iterates app.messages on the Batman project (another process may own that stream). Batman
//   sends use the gRPC client's messages.sendText("any;-;<addr>"), which is exactly what
//   @spectrum-ts/imessage does in shared mode (IMSG sendContent, line 1882). Batman reads use
//   messages.listInChat. The probe project uses a normal spectrum-ts app.messages stream.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Spectrum } from "spectrum-ts";
import type { PlatformProviderConfig } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";
import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { z } from "zod";
import {
  E164,
  deleteUser,
  ensureUser,
  listUsers,
  redact,
  redactText,
  SPECTRUM_BASE,
  basicAuth,
  type ProjectCreds,
  type SpectrumUser,
} from "../apps/probe/src/register.ts";

// ---------- env ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envFile = path.join(root, ".env");

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    const hash = v.indexOf(" #");
    if (hash >= 0) v = v.slice(0, hash).trim();
    out[m[1]!] = v.replace(/^"(.*)"$/, "$1");
  }
  return out;
}
const env = loadEnv(envFile);
function need(k: string): string {
  const v = env[k];
  if (!v) {
    console.error(`FAIL  .env is missing ${k}. Add it by name; this script never prints values.`);
    process.exit(2);
  }
  return v;
}

/** Sets KEY=value lines in .env in place (replace or append). Prints nothing about the values. */
function writeEnvVars(vars: Record<string, string>): void {
  const raw = fs.readFileSync(envFile, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^\\s*${k}\\s*=`);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else {
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(`${k}=${v}`, "");
    }
  }
  fs.writeFileSync(envFile, lines.join(eol), "utf8");
}

// ---------- logging ----------
const ts = () => new Date().toISOString();
const log = (...parts: unknown[]) =>
  console.log(`[${ts()}]`, ...parts.map((p) => redactText(typeof p === "string" ? p : (JSON.stringify(p) ?? String(p)))));

const GRPC_STATUS: Record<number, string> = {
  0: "OK", 1: "CANCELLED", 2: "UNKNOWN", 3: "INVALID_ARGUMENT", 4: "DEADLINE_EXCEEDED", 5: "NOT_FOUND",
  6: "ALREADY_EXISTS", 7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED", 9: "FAILED_PRECONDITION", 10: "ABORTED",
  11: "OUT_OF_RANGE", 12: "UNIMPLEMENTED", 13: "INTERNAL", 14: "UNAVAILABLE", 15: "DATA_LOSS", 16: "UNAUTHENTICATED",
};
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return redactText(String(e));
  const x = e as Error & { code?: unknown; grpcCode?: unknown; retryable?: unknown; status?: unknown; body?: unknown; context?: unknown };
  const bits = [`${e.constructor?.name ?? "Error"}`];
  if (typeof x.grpcCode === "number") bits.push(`grpc=${x.grpcCode} ${GRPC_STATUS[x.grpcCode] ?? "?"}`);
  if (typeof x.code === "string") bits.push(`code=${x.code}`);
  if (typeof x.status === "number") bits.push(`http=${x.status}`);
  if (typeof x.retryable === "boolean") bits.push(`retryable=${x.retryable}`);
  bits.push(`message="${e.message}"`);
  if (typeof x.body === "string") bits.push(`body=${x.body}`);
  if (x.context && typeof x.context === "object" && Object.keys(x.context).length) bits.push(`context=${JSON.stringify(x.context)}`);
  return redactText(bits.join(" "));
}

// ---------- projects ----------
const batman: ProjectCreds = { projectId: need("SPECTRUM_PROJECT_ID"), projectSecret: need("SPECTRUM_PROJECT_SECRET") };
const probe: ProjectCreds = { projectId: need("PROBE_PROJECT_ID"), projectSecret: need("PROBE_PROJECT_SECRET") };
const BATMAN_LINE = E164.parse(need("BATMAN_LINE_E164"));
// Loaded only to refuse touching them.
const forbidden = new Set([env.HUMAN_IPHONE_E164, env.TEST_GUARDIAN_E164].filter((x): x is string => !!x));
function assertPoolOnly(n: string, what: string): void {
  if (forbidden.has(n)) throw new Error(`refusing to ${what} ${redact(n)}: it is a real person's number`);
}

function logUsers(label: string, users: SpectrumUser[]): void {
  log(`${label}: ${users.length} user(s)`);
  for (const u of users)
    log(`  ${label} user type=${u.type} phone=${redact(u.phoneNumber)} assigned=${redact(u.assignedPhoneNumber)} assignedIsBatmanLine=${u.assignedPhoneNumber === BATMAN_LINE} phoneIsBatmanLine=${u.phoneNumber === BATMAN_LINE} created=${u.createdAt ?? "?"}`);
}

async function availability(creds: ProjectCreds, phone: string): Promise<string> {
  try {
    const r = await fetch(`${SPECTRUM_BASE}/projects/${creds.projectId}/imessage/shared/availability?phoneNumber=${encodeURIComponent(phone)}`, {
      headers: { authorization: basicAuth(creds) },
      signal: AbortSignal.timeout(15000),
    });
    return `HTTP ${r.status} ${redactText((await r.text()).slice(0, 300))}`;
  } catch (e) {
    return describeError(e);
  }
}

// ---------- Batman gRPC (send + listInChat only, no stream) ----------
const TokenSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shared"), token: z.string().min(1), expiresIn: z.number() }),
  z.object({ type: z.literal("dedicated"), auth: z.record(z.string(), z.string()), numbers: z.record(z.string(), z.string()), expiresIn: z.number() }),
]);
async function batmanGrpc(): Promise<AdvancedIMessage> {
  let tok: z.infer<typeof TokenSchema> | undefined;
  let mintedAt = 0;
  const mint = async () => {
    const r = await fetch(`${SPECTRUM_BASE}/projects/${batman.projectId}/imessage/tokens`, {
      method: "POST",
      headers: { authorization: basicAuth(batman) },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status !== 200) throw new Error(`POST /imessage/tokens -> HTTP ${r.status}`);
    tok = TokenSchema.parse(z.object({ data: z.unknown() }).parse(await r.json()).data);
    mintedAt = Date.now();
  };
  await mint();
  if (tok!.type !== "shared") throw new Error("Batman project is not shared; this spike assumes a shared pool");
  log(`Batman token minted: type=${tok!.type} expiresIn=${tok!.expiresIn}s`);
  return createGrpcClient({
    address: env.IMESSAGE_GRPC_ADDRESS || "imessage.spectrum.photon.codes:443",
    autoIdempotency: true,
    retry: true,
    tls: true,
    timeout: 20000,
    token: async () => {
      if (!tok || Date.now() - mintedAt > tok.expiresIn * 800) await mint();
      return (tok as { token: string }).token;
    },
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dm = (addr: string) => `any;-;${addr}`;

// ---------- step: list ----------
async function stepList(): Promise<{ bUsers: SpectrumUser[]; pUsers: SpectrumUser[] }> {
  const bUsers = await listUsers(batman);
  const pUsers = await listUsers(probe);
  log(`BATMAN_LINE_E164=${redact(BATMAN_LINE)}`);
  logUsers("batman", bUsers);
  logUsers("probe", pUsers);
  return { bUsers, pUsers };
}

// ---------- step: run ----------
type Round = { i: number; p2bMs: number | null; b2pMs: number | null; p2bNote: string; b2pNote: string };

async function stepRun(): Promise<void> {
  const { bUsers } = await stepList();

  // 1) Seed: register Batman's existing pool number on the probe project. A pool number is a
  //    Photon line, so this touches no real person. It gives the probe its first number.
  log("ORDER step 1: probe registers BATMAN_LINE_E164 (seed)");
  assertPoolOnly(BATMAN_LINE, "register");
  const s1 = await ensureUser(probe, BATMAN_LINE);
  let P = s1.user.assignedPhoneNumber;
  log(`  probe: phone=${redact(BATMAN_LINE)} -> assigned=${redact(P)} created=${s1.created} equalsBatmanLine=${P === BATMAN_LINE}`);
  if (P === BATMAN_LINE) throw new Error("probe was assigned the same pool number it should text; ordering impossible");

  // 2) S5: Batman sends to P while P is NOT a Batman user.
  const pAlreadyOnBatman = bUsers.some((u) => u.phoneNumber === P);
  const im = await batmanGrpc();
  let s5 = "";
  if (pAlreadyOnBatman) {
    s5 = "SKIPPED: probe number already registered on Batman, no unregistered pool number available";
    log(`S5 ${s5}`);
  } else {
    log(`S5 availability on Batman for ${redact(P)}: ${await availability(batman, P)}`);
    const text = `batman s5 unregistered ${ts()}`;
    log(`S5 Batman messages.sendText(${dm(P)}, "${text}") with ${redact(P)} unregistered on Batman`);
    try {
      const m = await im.messages.sendText(dm(P), text);
      s5 = `UNEXPECTED SUCCESS guid=set isSent=${m.isSent} sendErrorCode=${m.sendErrorCode}`;
    } catch (e) {
      s5 = `ERROR ${describeError(e)}`;
    }
    log(`S5 result: ${s5}`);
  }

  // 3) Batman registers P, getting B (the pool line Batman would use to text P).
  //    The first live run (2026-10-10) iterated this to look for a fixed point (Batman user P -> B and
  //    probe user B -> P). It never converged: every registration of a pool number returned a fresh
  //    pool number (3 iterations, 6 distinct numbers). It was removed so re-runs create no new users.
  assertPoolOnly(P, "register");
  const rb = await ensureUser(batman, P);
  const B = rb.user.assignedPhoneNumber;
  log(`ORDER step 2: batman registers ${redact(P)} -> assigned=${redact(B)} created=${rb.created} equalsBatmanLine=${B === BATMAN_LINE}`);
  const reciprocal = B === BATMAN_LINE;
  log(`reciprocal pair (Batman texts P from the same line the probe texts): ${reciprocal}`);
  if (reciprocal) {
    writeEnvVars({ PROBE_LINE_E164: P, BATMAN_LINE_FOR_PROBE_E164: B });
    log(".env updated: PROBE_LINE_E164, BATMAN_LINE_FOR_PROBE_E164 (values not printed)");
  } else if (process.argv.includes("--write-env")) {
    writeEnvVars({ PROBE_LINE_E164: P, BATMAN_LINE_FOR_PROBE_E164: BATMAN_LINE });
    log(".env updated (non-reciprocal, --write-env): PROBE_LINE_E164, BATMAN_LINE_FOR_PROBE_E164 (values not printed)");
  } else {
    log(".env NOT updated: no reciprocal pair exists (pass --write-env to force)");
  }

  // 4) S6: two-way messaging, 3 rounds.
  const app = await Spectrum({
    projectId: probe.projectId,
    projectSecret: probe.projectSecret,
    providers: [(imessage.config as unknown as (cfg?: Record<string, never>) => PlatformProviderConfig)({})],
    options: { logLevel: "silent" },
    telemetry: false,
  });
  const inbox: { text: string; at: number; sender: string; id: string }[] = [];
  let streamErr: unknown;
  const streamDone = (async () => {
    try {
      for await (const [, message] of app.messages) {
        if (message.direction !== "inbound") continue;
        const c = message.content;
        const text = c.type === "text" ? c.text : `<${c.type}>`;
        inbox.push({ text, at: Date.now(), sender: message.sender?.id ?? "?", id: message.id });
        log(`probe stream inbound type=${c.type} from=${redact(message.sender?.id)} text="${text.slice(0, 60)}"`);
      }
    } catch (e) {
      streamErr = e;
      log(`probe stream error: ${describeError(e)}`);
    }
  })();
  await sleep(3000); // let the stream subscribe before Batman sends
  // The probe has BATMAN_LINE registered as its user, so that is the only Batman number it may target.
  const probeSpace = await imessage(app).space.create(BATMAN_LINE);

  const rounds: Round[] = [];
  for (let i = 1; i <= 3; i++) {
    const r: Round = { i, p2bMs: null, b2pMs: null, p2bNote: "", b2pNote: "" };
    // probe -> batman
    const t1 = `probe->batman ${ts()}`;
    const s1t = Date.now();
    try {
      const sent = await probeSpace.send(t1);
      r.p2bNote = `sent id=${sent?.id ? "set" : "undefined"} sendCallMs=${Date.now() - s1t}`;
    } catch (e) {
      r.p2bNote = `send error ${describeError(e)}`;
    }
    if (!r.p2bNote.startsWith("send error")) {
      let lastErr = "";
      while (Date.now() - s1t < 10000 && r.p2bMs === null) {
        try {
          const page = await im.messages.listInChat(dm(P), { pageSize: 20, after: new Date(s1t - 60000) });
          const hit = page.messages.find((m) => !m.isFromMe && m.content.text === t1);
          if (hit) {
            r.p2bMs = Date.now() - s1t;
            r.p2bNote += ` seenOnBatman sender=${redact(hit.sender?.address)} senderIsP=${hit.sender?.address === P} chat=${redactText(hit.chatGuids.join(","))} serverDateCreatedDeltaMs=${hit.dateCreated.getTime() - s1t}`;
          }
        } catch (e) {
          lastErr = describeError(e);
        }
        if (r.p2bMs === null) await sleep(400);
      }
      if (r.p2bMs === null) r.p2bNote += ` NOT SEEN on Batman within 10s${lastErr ? ` lastListError=${lastErr}` : ""}`;
    }
    log(`S6 round ${i} probe->batman: ${r.p2bMs ?? "FAIL"} ms; ${r.p2bNote}`);

    // batman -> probe
    const t2 = `batman->probe ${ts()}`;
    const s2t = Date.now();
    try {
      const m = await im.messages.sendText(dm(P), t2);
      r.b2pNote = `sent guid=set isSent=${m.isSent} sendErrorCode=${m.sendErrorCode} sendCallMs=${Date.now() - s2t}`;
    } catch (e) {
      r.b2pNote = `send error ${describeError(e)}`;
    }
    if (!r.b2pNote.startsWith("send error")) {
      while (Date.now() - s2t < 10000) {
        const hit = inbox.find((m) => m.text === t2);
        if (hit) {
          r.b2pMs = hit.at - s2t;
          r.b2pNote += ` seenOnProbe sender=${redact(hit.sender)} senderIsB=${hit.sender === B} senderIsBatmanLine=${hit.sender === BATMAN_LINE}`;
          break;
        }
        await sleep(100);
      }
      if (r.b2pMs === null) r.b2pNote += " NOT SEEN on probe stream within 10s";
    }
    log(`S6 round ${i} batman->probe: ${r.b2pMs ?? "FAIL"} ms; ${r.b2pNote}`);
    rounds.push(r);
    await sleep(2000);
  }

  // Late arrivals (after the 10 s window) are worth recording too.
  await sleep(5000);
  if (rounds.some((r) => r.b2pMs === null)) {
    log(`late check: probe inbox has ${inbox.length} message(s): ${inbox.map((m) => `"${m.text.slice(0, 40)}"`).join(" | ")}`);
  }
  if (rounds.some((r) => r.p2bMs === null)) {
    try {
      const page = await im.messages.listInChat(dm(P), { pageSize: 20 });
      log(`late listInChat(${dm(P)}): ${page.messages.length} msg(s): ` +
        page.messages.map((m) => `${m.isFromMe ? "out" : "in"}:"${(m.content.text ?? "").slice(0, 40)}"`).join(" | "));
    } catch (e) {
      log(`late listInChat error: ${describeError(e)}`);
    }
  }

  const ok = rounds.every((r) => r.p2bMs !== null && r.b2pMs !== null && r.p2bMs <= 10000 && r.b2pMs <= 10000);
  log(`SUMMARY S5: ${s5}`);
  log(`SUMMARY S6: ${ok ? "PASS" : "FAIL"} rounds=${JSON.stringify(rounds.map((r) => ({ i: r.i, p2bMs: r.p2bMs, b2pMs: r.b2pMs })))}${streamErr ? " (probe stream errored)" : ""}`);
  if (!ok) process.exitCode = 1;

  await app.stop().catch(() => undefined);
  await Promise.race([streamDone, sleep(3000)]);
  await im.close().catch(() => undefined);
}

// ---------- step: cleanup ----------
// Removes users whose phoneNumber is itself a Photon pool line (BATMAN_LINE or any number some
// project assigned). Those users can never receive messages ("Target is a Photon-managed shared
// line") and only consume maxSharedUsers. Real people's users are never touched. Dry run unless --yes.
async function stepCleanup(): Promise<void> {
  const { bUsers, pUsers } = await stepList();
  const pool = new Set<string>([BATMAN_LINE]);
  for (const u of [...bUsers, ...pUsers]) if (u.assignedPhoneNumber) pool.add(u.assignedPhoneNumber);
  const yes = process.argv.includes("--yes");
  for (const [label, creds, users] of [["batman", batman, bUsers], ["probe", probe, pUsers]] as const) {
    for (const u of users) {
      if (!pool.has(u.phoneNumber) || forbidden.has(u.phoneNumber)) continue;
      if (!yes) {
        log(`cleanup (dry run) would delete ${label} user phone=${redact(u.phoneNumber)}`);
        continue;
      }
      try {
        await deleteUser(creds, u.id);
        log(`cleanup deleted ${label} user phone=${redact(u.phoneNumber)}`);
      } catch (e) {
        log(`cleanup failed for ${label} user phone=${redact(u.phoneNumber)}: ${describeError(e)}`);
      }
    }
  }
  if (!yes) log("dry run only; pass --yes to delete");
}

// ---------- main ----------
const step = process.argv[2];
try {
  if (step === "list") await stepList();
  else if (step === "run") await stepRun();
  else if (step === "cleanup") await stepCleanup();
  else {
    console.error("usage: npx tsx scripts/spike-probe.ts <list|run|cleanup [--yes]>");
    process.exit(2);
  }
} catch (e) {
  log(`fatal: ${describeError(e)}`);
  process.exitCode = 1;
}
log("done");
process.exit(process.exitCode ?? 0);
