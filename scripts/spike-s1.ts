// Spike S1 (spec Section 14, 0b): can our shared-pool project read Find My locations
// through @photon-ai/advanced-imessage over gRPC?
//
// Run directly:  npx tsx scripts/spike-s1.ts <focus|request|poll [--once]|watch|users|control>
//
// Loads .env itself (no dotenv). Never prints secrets or the minted token.
// Phone numbers are redacted to the last 4 digits in all output.
// gRPC only: this script never starts a spectrum-ts message stream.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  AdvancedIMessage,
  ClientOptions,
  SharedFriendLocation,
  SharedFriendLocationUpdated,
} from "../apps/server/node_modules/@photon-ai/advanced-imessage/dist/grpc.js";

// ---------- paths and env ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

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
const env = loadEnv(path.join(root, ".env"));
function need(k: string): string {
  const v = env[k];
  if (!v) {
    console.error(`FAIL  .env is missing ${k}. Add it by name; this script never prints values.`);
    process.exit(2);
  }
  return v;
}

// ---------- redaction and logging ----------
// Redacts E.164 numbers (+ and 7 to 15 digits) and bare digit runs of 7+ (ISO dates are 4-digit groups, so they pass through).
const redact = (s: string): string => s.replace(/\+\d{7,15}|(?<![\d.])\d{7,15}(?![\d.])/g, (m) => `***${m.slice(-4)}`);
const ts = () => new Date().toISOString();
const log = (...parts: unknown[]) =>
  console.log(`[${ts()}]`, ...parts.map((p) => (typeof p === "string" ? redact(p) : redact(JSON.stringify(p, null, 0) ?? String(p)))));

const GRPC_STATUS: Record<number, string> = {
  0: "OK", 1: "CANCELLED", 2: "UNKNOWN", 3: "INVALID_ARGUMENT", 4: "DEADLINE_EXCEEDED", 5: "NOT_FOUND",
  6: "ALREADY_EXISTS", 7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED", 9: "FAILED_PRECONDITION", 10: "ABORTED",
  11: "OUT_OF_RANGE", 12: "UNIMPLEMENTED", 13: "INTERNAL", 14: "UNAVAILABLE", 15: "DATA_LOSS", 16: "UNAUTHENTICATED",
};

type ErrInfo = { class: string; message: string; code?: string; grpcCode?: number; grpcStatus?: string; retryable?: boolean; source?: string; requestId?: string };
function describeError(e: unknown): ErrInfo {
  if (e instanceof Error) {
    const x = e as Error & { code?: unknown; grpcCode?: unknown; retryable?: unknown; source?: unknown; requestId?: unknown };
    const info: ErrInfo = { class: e.constructor?.name ?? "Error", message: redact(e.message) };
    if (typeof x.code === "string") info.code = x.code;
    if (typeof x.grpcCode === "number") { info.grpcCode = x.grpcCode; info.grpcStatus = GRPC_STATUS[x.grpcCode] ?? "?"; }
    if (typeof x.retryable === "boolean") info.retryable = x.retryable;
    if (typeof x.source === "string") info.source = x.source;
    if (typeof x.requestId === "string") info.requestId = x.requestId;
    return info;
  }
  return { class: typeof e, message: redact(String(e)) };
}
const logError = (label: string, e: unknown) => {
  const d = describeError(e);
  log(`ERROR ${label}: ${d.class} ${d.grpcStatus ? `grpc=${d.grpcCode} ${d.grpcStatus}` : "(no grpcCode)"} code=${d.code ?? "-"} retryable=${d.retryable ?? "-"} source=${d.source ?? "-"} requestId=${d.requestId ?? "-"} message="${d.message}"`);
};

// ---------- token minting (spec 11.3, PHOTON_NOTES C) ----------
type TokenData =
  | { type: "dedicated"; auth: Record<string, string>; numbers: Record<string, string>; expiresIn: number }
  | { type: "shared"; token: string; expiresIn: number };

async function mintToken(projectId: string, projectSecret: string): Promise<TokenData> {
  const auth = "Basic " + Buffer.from(`${projectId}:${projectSecret}`).toString("base64");
  const url = `https://spectrum.photon.codes/projects/${projectId}/imessage/tokens`;
  const r = await fetch(url, { method: "POST", headers: { authorization: auth }, signal: AbortSignal.timeout(15000) });
  if (r.status !== 200) throw new Error(`POST /imessage/tokens -> HTTP ${r.status}`);
  const j = (await r.json()) as { succeed?: boolean; data?: TokenData };
  if (!j.data || !("type" in j.data)) throw new Error("POST /imessage/tokens: unexpected envelope (no data.type)");
  const d = j.data;
  if (d.type === "shared" && typeof d.token !== "string") throw new Error("shared token missing");
  if (d.type === "dedicated" && (!d.auth || Object.keys(d.auth).length === 0)) throw new Error("dedicated token has no auth map");
  // Never log the token.
  log(`token minted: type=${d.type} expiresIn=${d.expiresIn}s${d.type === "dedicated" ? ` instances=${Object.keys(d.auth).length}` : ""}`);
  return d;
}

// ---------- client, built exactly like @spectrum-ts/imessage createCloudClients ----------
// Import path: "@photon-ai/advanced-imessage/grpc" resolved from apps/server (the root workspace
// does not depend on the package). Signature: createGrpcClient(options: ClientOptions): AdvancedIMessage.
const serverRequire = createRequire(path.join(root, "apps", "server", "package.json"));
const grpcEntry = serverRequire.resolve("@photon-ai/advanced-imessage/grpc");
type GrpcModule = { createGrpcClient: (o: ClientOptions) => AdvancedIMessage; NotFoundError: new (...a: never[]) => Error; AuthenticationError: new (...a: never[]) => Error };
const grpcMod = (await import(pathToFileURL(grpcEntry).href)) as GrpcModule;

async function buildClient(opts: { onHeartbeat?: () => void } = {}): Promise<{ im: AdvancedIMessage; address: string }> {
  const projectId = need("SPECTRUM_PROJECT_ID");
  const projectSecret = need("SPECTRUM_PROJECT_SECRET");
  let tokenData = await mintToken(projectId, projectSecret);
  let mintedAt = Date.now();
  const refreshIfNeeded = async () => {
    if (Date.now() - mintedAt > tokenData.expiresIn * 1000 * 0.8) {
      tokenData = await mintToken(projectId, projectSecret);
      mintedAt = Date.now();
    }
  };
  let address: string;
  let tokenFn: () => Promise<string>;
  if (tokenData.type === "shared") {
    address = env.IMESSAGE_GRPC_ADDRESS || process.env.SPECTRUM_IMESSAGE_ADDRESS || "imessage.spectrum.photon.codes:443";
    tokenFn = async () => { await refreshIfNeeded(); return (tokenData as { token: string }).token; };
  } else {
    const instanceId = Object.keys(tokenData.auth)[0]!;
    address = `${instanceId}.imsg.photon.codes:443`;
    log(`dedicated line instance=${instanceId} number=${tokenData.numbers[instanceId] ?? "?"}`);
    tokenFn = async () => { await refreshIfNeeded(); return (tokenData as { auth: Record<string, string> }).auth[instanceId]!; };
  }
  const options: ClientOptions = {
    address,
    autoIdempotency: true,
    retry: true,
    tls: true,
    timeout: 30000,
    token: tokenFn,
    ...(opts.onHeartbeat ? { onHeartbeat: opts.onHeartbeat } : {}),
  };
  log(`createGrpcClient from ${grpcEntry.replace(root, "<root>")}`);
  log(`createGrpcClient({ address: "${address}", autoIdempotency: true, retry: true, tls: true, timeout: 30000, token: async fn })`);
  return { im: grpcMod.createGrpcClient(options), address };
}

// ---------- helpers ----------
const r2 = (n: number | undefined) => (typeof n === "number" ? n.toFixed(2) : "absent");
function fmtLoc(l: SharedFriendLocation): string {
  return `addr=${l.address} lat=${r2(l.latitude)} lng=${r2(l.longitude)} accuracy=${l.accuracy ?? "absent"}m type=${l.locationType} locating=${l.isLocatingInProgress} ts=${l.locationTimestamp?.toISOString() ?? "absent"} expiresAt=${l.expiresAt?.toISOString() ?? "absent"} name=${l.name ? "set" : "absent"}`;
}
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const isNotFound = (e: unknown) => e instanceof grpcMod.NotFoundError || (e instanceof Error && (e as { grpcCode?: number }).grpcCode === 5);

// Invariant I2: on a shared pool, list() may expose other people's shares. Report only the
// count and the last 4 digits of each address; never their coordinates.
async function listOnce(im: AdvancedIMessage, target: string): Promise<void> {
  try {
    const list = await im.locations.list();
    const last4 = list.map((l) => `***${l.address.replace(/\D/g, "").slice(-4) || "????"}`);
    log(`locations.list(): count=${list.length} addresses=[${last4.join(", ")}] includesTarget=${list.some((l) => l.address === target)}`);
  } catch (e) {
    logError("locations.list()", e);
  }
}

// ---------- steps ----------
// users: list the project's registered users (Spectrum API, no gRPC) to explain "Target not allowed".
async function stepUsers(address: string): Promise<void> {
  const projectId = need("SPECTRUM_PROJECT_ID");
  const auth = "Basic " + Buffer.from(`${projectId}:${need("SPECTRUM_PROJECT_SECRET")}`).toString("base64");
  for (const p of [`/projects/${projectId}/imessage/`, `/projects/${projectId}/users/?limit=50`, `/projects/${projectId}/imessage/shared/availability?phoneNumber=${encodeURIComponent(address)}`]) {
    try {
      const r = await fetch(`https://spectrum.photon.codes${p}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(15000) });
      const body = (await r.json()) as { data?: unknown };
      const d = body.data as { users?: Array<{ type?: string; phoneNumber?: string; assignedPhoneNumber?: string; createdAt?: string }> } | undefined;
      if (d?.users) {
        log(`GET ${p.replace(projectId, "{id}")} -> HTTP ${r.status}, ${d.users.length} users`);
        for (const u of d.users) log(`  user: type=${u.type} phone=${u.phoneNumber} assigned=${u.assignedPhoneNumber} created=${u.createdAt}`);
        log(`  target ${address} registered: ${d.users.some((u) => u.phoneNumber === address)}`);
      } else {
        log(`GET ${p.replace(projectId, "{id}").replace(address, redact(address))} -> HTTP ${r.status}`, body.data);
      }
    } catch (e) {
      logError(`GET ${p.replace(projectId, "{id}")}`, e);
    }
  }
}

async function stepFocus(im: AdvancedIMessage, address: string): Promise<void> {
  try {
    const avail = await im.addresses.isIMessageAvailable(address);
    log(`addresses.isIMessageAvailable(${address}) = ${avail}`);
  } catch (e) {
    logError("addresses.isIMessageAvailable", e);
  }
  try {
    const silenced = await im.addresses.isFocusSilenced(address);
    log(`addresses.isFocusSilenced(${address}) = ${silenced}`);
  } catch (e) {
    logError("addresses.isFocusSilenced", e);
  }
  try {
    const info = await im.addresses.get(address);
    log(`addresses.get(${address}) =`, info);
  } catch (e) {
    logError("addresses.get", e);
  }
}

async function stepRequest(im: AdvancedIMessage, address: string): Promise<void> {
  // Shared mode: the DM GUID is deterministic, no chats.create round trip (PHOTON_NOTES mismatch 14).
  const chatGuid = `any;-;${address}`;
  log(`DM chat GUID (computed like @spectrum-ts/imessage dmChatGuid): ${chatGuid}`);
  const clientMessageId = `loc-spike-s1-${Date.now()}`;
  try {
    const receipt = await im.locations.request(chatGuid, address, { clientMessageId });
    log(`locations.request(${chatGuid}, ${address}, { clientMessageId: "${clientMessageId}" }) ->`, {
      status: receipt.status, reason: receipt.reason ?? null, messageGuid: receipt.messageGuid ?? null, address: receipt.address,
    });
    log("REQUEST SENT. The iPhone should now show a Find My share request card in the Batman thread.");
  } catch (e) {
    logError("locations.request", e);
  }
  // Immediate visibility check (expected NotFoundError until the human taps Share).
  try {
    const l = await im.locations.get(address);
    log(`locations.get right after request: ${fmtLoc(l)}`);
  } catch (e) {
    if (isNotFound(e)) log("locations.get right after request: NotFoundError (not shared yet, expected)");
    else logError("locations.get", e);
  }
}

// control: read-only messaging RPCs against the same target. Sends nothing. Distinguishes
// "target not on the allowlist" (these fail too) from "location/address RPCs not exposed on the
// shared pool" (these succeed). Logs counts and flags only, never message text.
async function stepControl(im: AdvancedIMessage, address: string): Promise<void> {
  const chatGuid = `any;-;${address}`;
  try {
    const c = await im.chats.get(chatGuid);
    log(`chats.get(${chatGuid}) OK: guid=${c.guid} isGroup=${c.isGroup}`);
  } catch (e) {
    logError("chats.get", e);
  }
  try {
    const page = await im.messages.listInChat(chatGuid, { pageSize: 5 });
    log(`messages.listInChat(${chatGuid}, { pageSize: 5 }) OK: count=${page.messages.length} hasNextPage=${Boolean(page.nextPageToken)}`);
  } catch (e) {
    logError("messages.listInChat", e);
  }
}

async function stepPoll(im: AdvancedIMessage, address: string, once: boolean): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000;
  let n = 0;
  while (Date.now() < deadline) {
    n++;
    try {
      const l = await im.locations.get(address);
      log(`poll #${n}: SHARED ${fmtLoc(l)}`);
      if (typeof l.latitude === "number" && typeof l.longitude === "number") {
        log(`PASS: coordinates visible (locationType=${l.locationType})`);
        await listOnce(im, address);
        return;
      }
      log("share visible but latitude/longitude absent; keep polling");
    } catch (e) {
      if (isNotFound(e)) log(`poll #${n}: NotFoundError (not shared yet)`);
      else logError(`poll #${n} locations.get`, e);
    }
    if (once) {
      await listOnce(im, address);
      log("--once: stopping after one iteration");
      return;
    }
    await sleep(30000);
  }
  await listOnce(im, address);
  log("FAIL: 15 min elapsed without a visible share");
  process.exitCode = 1;
}

async function stepWatch(address: string): Promise<void> {
  let heartbeats = 0;
  const { im } = await buildClient({ onHeartbeat: () => { heartbeats++; log(`heartbeat #${heartbeats}`); } });
  const deadline = Date.now() + 5 * 60 * 1000;
  let updates = 0;
  let dupes = 0;
  let lastSeq = -1;
  const hb = setInterval(async () => {
    try {
      const l = await im.locations.get(address);
      log(`get() heartbeat: ${fmtLoc(l)}`);
    } catch (e) {
      if (isNotFound(e)) log("get() heartbeat: NotFoundError (not shared)");
      else logError("get() heartbeat", e);
    }
  }, 60000);
  let backoff = 1000;
  let stream: ReturnType<typeof im.locations.watch> | undefined;
  const closer = setTimeout(() => { log("5 min reached, closing stream"); void stream?.close(); }, deadline - Date.now());
  try {
    while (Date.now() < deadline) {
      try {
        log(`locations.watch(${address}) opening`);
        stream = im.locations.watch(address);
        for await (const u of stream as AsyncIterable<SharedFriendLocationUpdated>) {
          if (u.sourceSequence <= lastSeq) {
            dupes++;
            log(`dropped duplicate/out-of-order seq=${u.sourceSequence} (lastSeq=${lastSeq})`);
            continue;
          }
          updates++;
          lastSeq = u.sourceSequence;
          backoff = 1000;
          log(`update #${updates} seq=${u.sourceSequence} ${fmtLoc(u.location)}`);
          if (Date.now() >= deadline) break;
        }
        if (Date.now() >= deadline) break;
        log(`watch stream ended by server; reconnecting in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      } catch (e) {
        logError("locations.watch", e);
        if (Date.now() >= deadline) break;
        const d = describeError(e);
        if (d.grpcCode === 7 || d.grpcCode === 16 || d.grpcCode === 12) { log("not retrying: permission/auth/unimplemented"); break; }
        log(`reconnecting in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  } finally {
    clearInterval(hb);
    clearTimeout(closer);
    await stream?.close().catch(() => undefined);
    log(`watch summary: updates=${updates} duplicatesDropped=${dupes} heartbeats=${heartbeats} lastSeq=${lastSeq}`);
    if (updates === 0) process.exitCode = 1;
    await im.close().catch(() => undefined);
  }
}

// ---------- main ----------

// track: get() every 20 s plus a concurrent watch() for N minutes (default 6).
// Prints only distances in meters (from the first fix and from the previous one), never coordinates.
function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function stepTrack(address: string, minutes: number): Promise<void> {
  const { im } = await buildClient();
  const deadline = Date.now() + minutes * 60 * 1000;
  let first: { lat: number; lng: number } | null = null;
  let prev: { lat: number; lng: number; at: number } | null = null;
  let maxFromStart = 0;
  const report = (src: string, l: SharedFriendLocation) => {
    if (typeof l.latitude !== "number" || typeof l.longitude !== "number") { log(`${src}: no coordinates`); return; }
    const p = { lat: l.latitude, lng: l.longitude };
    const ts = l.locationTimestamp?.getTime() ?? Date.now();
    if (!first) first = p;
    const fromStart = haversineM(first, p);
    maxFromStart = Math.max(maxFromStart, fromStart);
    const step = prev ? haversineM(prev, p) : 0;
    const speed = prev && ts > prev.at ? step / ((ts - prev.at) / 1000) : 0;
    log(`${src}: fromStart=${fromStart.toFixed(0)}m step=${step.toFixed(0)}m speed=${speed.toFixed(1)}m/s acc=${Math.round(l.accuracy ?? -1)}m type=${l.locationType} fixAge=${Math.round((Date.now() - ts) / 1000)}s`);
    prev = { ...p, at: ts };
  };
  const stream = im.locations.watch(address);
  const watcher = (async () => {
    try { for await (const u of stream as AsyncIterable<SharedFriendLocationUpdated>) report(`watch seq=${u.sourceSequence}`, u.location); }
    catch (e) { logError("watch", e); }
  })();
  log(`TRACK RUNNING until ${new Date(deadline).toISOString()}`);
  while (Date.now() < deadline) {
    try { report("get", await im.locations.get(address)); } catch (e) { logError("get", e); }
    await sleep(20000);
  }
  await stream.close().catch(() => undefined);
  await watcher;
  log(`TRACK DONE maxFromStart=${maxFromStart.toFixed(0)}m`);
  await im.close().catch(() => undefined);
}

const step = process.argv[2];
const address = need("HUMAN_IPHONE_E164");
if (!/^\+[1-9]\d{6,14}$/.test(address)) { console.error("FAIL  HUMAN_IPHONE_E164 must be E.164"); process.exit(2); }
log(`spike S1 step=${step ?? "(none)"} target=${address}`);

try {
  switch (step) {
    case "focus": { const { im } = await buildClient(); try { await stepFocus(im, address); } finally { await im.close().catch(() => undefined); } break; }
    case "request": { const { im } = await buildClient(); try { await stepRequest(im, address); } finally { await im.close().catch(() => undefined); } break; }
    case "poll": { const { im } = await buildClient(); try { await stepPoll(im, address, process.argv.includes("--once")); } finally { await im.close().catch(() => undefined); } break; }
    case "control": { const { im } = await buildClient(); try { await stepControl(im, address); } finally { await im.close().catch(() => undefined); } break; }
    case "watch": await stepWatch(address); break;
    case "track": await stepTrack(address, Number(process.argv[3] ?? 6)); break;
    case "users": await stepUsers(address); break;
    default:
      console.error("usage: npx tsx scripts/spike-s1.ts <focus|request|poll [--once]|watch|users|control>");
      process.exit(2);
  }
} catch (e) {
  logError("fatal", e);
  process.exitCode = 1;
}
log("done");
process.exit(process.exitCode ?? 0);
