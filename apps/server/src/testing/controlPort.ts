// Test control port (spec 16.1). Exists only when TEST_MODE=1, binds 127.0.0.1 only, and
// rejects any non-loopback peer. Never returns code words, secrets, or full phone numbers.
//   GET  /state?user=+1...    plan state, ladder step, last outbound ids and template ids
//   POST /replay {track,user?} switch the user's LocationSource to a replay track
//   POST /ff {minutes}         fast-forward the clock
//   POST /reset {user}         delete a test user's data
//   GET  /outbox?since=ISO     outbound messages sent (redacted bodies)
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { E164 } from "../contracts.js";
import type { Store } from "../store/db.js";
import * as repo from "../store/repo.js";

export const LOOPBACK = "127.0.0.1";
const E164_RE = /^\+[1-9]\d{6,14}$/;
const last4 = (s: string) => `***${s.replace(/\D/g, "").slice(-4)}`;

export interface ControlPortDeps {
  store: Store;
  fastForward?: (minutes: number) => Promise<void> | void;
  replay?: (user: E164 | null, track: string) => Promise<void>;
  /** Extra state for /state (scrubbed of secret-looking keys). */
  extraState?: (user: E164) => Record<string, unknown>;
}

export interface ControlPort {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  readonly server: http.Server;
}

const ffBody = z.object({ minutes: z.number().positive().max(24 * 60) });
const replayBody = z.object({ track: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), user: z.string().regex(E164_RE).optional() });
const resetBody = z.object({ user: z.string().regex(E164_RE) });

const SECRET_KEY_RE = /secret|token|password|apikey|api_key|authorization|phrase|codeword|code_word|exit|alert_word/i;

function scrubKeys(v: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth]";
  if (Array.isArray(v)) return v.map((x) => scrubKeys(x, depth + 1));
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!SECRET_KEY_RE.test(k)) out[k] = scrubKeys(x, depth + 1);
    return out;
  }
  return v;
}

export function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

interface OutRow {
  platform_message_id: string | null;
  address_e164: string;
  plan_id: string | null;
  kind: string;
  body_redacted: string | null;
  sent_at: number;
}

export function readState(store: Store, user: E164): Record<string, unknown> {
  const u = repo.getUserByAddress(store, user);
  if (!u) return { user: last4(user), known: false };
  const plan = repo.getOpenPlanForUser(store, u.id);
  const guardian = plan?.guardianId ? repo.getGuardian(store, plan.guardianId) : null;
  const addrs = [user, ...(guardian ? [guardian.addressE164] : [])];
  const rows = store.sqlite
    .prepare(
      `SELECT platform_message_id, address_e164, plan_id, kind, body_redacted, sent_at FROM messages
       WHERE direction = 'outbound' AND address_e164 IN (${addrs.map(() => "?").join(",")}) ORDER BY sent_at DESC, id DESC LIMIT 10`,
    )
    .all(...addrs) as OutRow[];
  return {
    user: last4(user),
    known: true,
    onboardingStep: u.onboardingStep,
    plan: plan
      ? {
          id: plan.id,
          state: plan.state,
          type: plan.type,
          ladderStep: plan.ladderStep,
          ladderClass: plan.ladderClass,
          ladderTrigger: plan.ladderTrigger,
          startAt: plan.startAt,
          endAt: plan.endAt,
          lastCheckinMessageId: plan.lastCheckinMessageId,
        }
      : null,
    lastOutbound: rows.map((r) => ({ id: r.platform_message_id, to: r.address_e164 === user ? "user" : "guardian", template: r.kind, at: new Date(r.sent_at) })),
  };
}

export function readOutbox(store: Store, since: Date | null): Record<string, unknown>[] {
  const rows = store.sqlite
    .prepare(
      "SELECT platform_message_id, address_e164, plan_id, kind, body_redacted, sent_at FROM messages WHERE direction = 'outbound' AND sent_at >= ? ORDER BY sent_at ASC, id ASC LIMIT 500",
    )
    .all(since ? since.getTime() : 0) as OutRow[];
  return rows.map((r) => ({ id: r.platform_message_id, to: last4(r.address_e164), planId: r.plan_id, template: r.kind, body: r.body_redacted, at: new Date(r.sent_at) }));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(scrubKeys(body)));
}

/** null unless TEST_MODE is on. */
export function createControlPort(env: { TEST_MODE: boolean; TEST_CONTROL_PORT: number }, deps: ControlPortDeps): ControlPort | null {
  if (!env.TEST_MODE) return null;
  const server = http.createServer((req, res) => {
    void (async () => {
      if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: "loopback only" });
      const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
      try {
        if (req.method === "GET" && url.pathname === "/state") {
          const user = url.searchParams.get("user") ?? "";
          if (!E164_RE.test(user)) return send(res, 400, { error: "user must be E.164" });
          const state = readState(deps.store, user as E164);
          return send(res, 200, deps.extraState ? { ...state, ...deps.extraState(user as E164) } : state);
        }
        if (req.method === "GET" && url.pathname === "/outbox") {
          const since = url.searchParams.get("since");
          const d = since ? new Date(since) : null;
          if (d && Number.isNaN(d.getTime())) return send(res, 400, { error: "since must be an ISO date" });
          return send(res, 200, { messages: readOutbox(deps.store, d) });
        }
        if (req.method === "POST" && url.pathname === "/ff") {
          const b = ffBody.safeParse(await readJson(req));
          if (!b.success) return send(res, 400, { error: "minutes must be a positive number" });
          if (!deps.fastForward) return send(res, 501, { error: "fast-forward not available" });
          await deps.fastForward(b.data.minutes);
          return send(res, 200, { ok: true, minutes: b.data.minutes });
        }
        if (req.method === "POST" && url.pathname === "/replay") {
          const b = replayBody.safeParse(await readJson(req));
          if (!b.success) return send(res, 400, { error: "track must be a track name" });
          if (!deps.replay) return send(res, 501, { error: "replay not available" });
          await deps.replay((b.data.user as E164 | undefined) ?? null, b.data.track);
          return send(res, 200, { ok: true, track: b.data.track });
        }
        if (req.method === "POST" && url.pathname === "/reset") {
          const b = resetBody.safeParse(await readJson(req));
          if (!b.success) return send(res, 400, { error: "user must be E.164" });
          const u = repo.getUserByAddress(deps.store, b.data.user as E164);
          if (u) repo.deleteUserData(deps.store, u.id);
          deps.store.sqlite.prepare("DELETE FROM messages WHERE address_e164 = ?").run(b.data.user);
          return send(res, 200, { ok: true, deleted: !!u });
        }
        return send(res, 404, { error: "not found" });
      } catch (err) {
        return send(res, 500, { error: err instanceof Error ? err.message.slice(0, 200) : "error" });
      }
    })();
  });
  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(env.TEST_CONTROL_PORT, LOOPBACK, () => {
          const a = server.address() as AddressInfo;
          resolve({ host: a.address, port: a.port });
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
