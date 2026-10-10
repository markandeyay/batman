// pnpm admin:add-user +1XXXXXXXXXX [--probe] [--first Name]
// Registers a phone number as a Spectrum user on the Batman project (or the probe project with --probe)
// and prints the assigned Batman number and the sms: redirect link (spec 11.1).
// Idempotent: an already-registered number is looked up instead of re-created.
// Prints numbers redacted to the last 4 digits unless --show is passed (the human's own terminal only).
import { z } from "zod";
import { loadEnv } from "../apps/server/src/config/env.ts";

const args = process.argv.slice(2);
const phone = args.find((a) => a.startsWith("+"));
const useProbe = args.includes("--probe");
const show = args.includes("--show");
const firstIdx = args.indexOf("--first");
const firstName = firstIdx >= 0 ? args[firstIdx + 1] : undefined;

if (!phone || !/^\+[1-9]\d{6,14}$/.test(phone)) {
  console.log("usage: pnpm admin:add-user +19195550100 [--probe] [--first Name] [--show]");
  process.exit(1);
}

const env = loadEnv();
const projectId = useProbe ? env.PROBE_PROJECT_ID : env.SPECTRUM_PROJECT_ID;
const secret = useProbe ? env.PROBE_PROJECT_SECRET : env.SPECTRUM_PROJECT_SECRET;
if (!projectId || !secret) {
  console.log(`missing ${useProbe ? "PROBE_PROJECT_ID / PROBE_PROJECT_SECRET" : "SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET"} in .env`);
  process.exit(1);
}

const BASE = "https://spectrum.photon.codes";
const auth = "Basic " + Buffer.from(`${projectId}:${secret}`).toString("base64");
const fmt = (n: string | null | undefined) => (!n ? "(none)" : show ? n : `***${n.slice(-4)}`);

const User = z.object({
  id: z.string(),
  type: z.enum(["shared", "dedicated"]),
  phoneNumber: z.string(),
  assignedPhoneNumber: z.string().nullable().optional(),
});
const Envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ succeed: z.literal(true), data });

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, body };
}

const typeRes = await call(`/projects/${projectId}/imessage/`);
const lineType = Envelope(z.object({ type: z.enum(["shared", "dedicated"]) })).safeParse(typeRes.body);
if (typeRes.status !== 200 || !lineType.success) {
  console.log(`could not read project line type (HTTP ${typeRes.status})`);
  process.exit(1);
}

const list = await call(`/projects/${projectId}/users/`);
const listed = Envelope(z.object({ users: z.array(User) })).safeParse(list.body);
let user = listed.success ? listed.data.data.users.find((u) => u.phoneNumber === phone) : undefined;

if (user) {
  console.log(`already registered (${user.type})`);
} else {
  const res = await call(`/projects/${projectId}/users/`, {
    method: "POST",
    body: JSON.stringify({ type: lineType.data.data.type, phoneNumber: phone, ...(firstName ? { firstName } : {}) }),
  });
  const created = Envelope(User).safeParse(res.body);
  if (res.status >= 300 || !created.success) {
    console.log(`registration failed (HTTP ${res.status})`);
    process.exit(1);
  }
  user = created.data.data;
  console.log(`registered (${user.type})`);
}

const redirect = await fetch(`${BASE}/users/${user.id}/redirect`, { redirect: "manual", signal: AbortSignal.timeout(15000) });
const link = redirect.headers.get("location");

console.log(`project:          ${useProbe ? "probe" : "batman"} (${lineType.data.data.type})`);
console.log(`user phone:       ${fmt(user.phoneNumber)}`);
console.log(`assigned number:  ${fmt(user.assignedPhoneNumber)}  <- the number this person texts`);
console.log(`start link:       ${link ? (show ? link : link.replace(/\+?\d{7,}/g, (m) => `***${m.slice(-4)}`)) : "(none)"}`);
