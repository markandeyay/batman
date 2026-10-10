// Shared-pool user registration against the Spectrum management API (spec 11.1, PHOTON_NOTES C).
// POST /projects/{projectId}/users/ with { type: "shared", phoneNumber } assigns a pool number
// (assignedPhoneNumber) that will text this user. GET /projects/{projectId}/users/ lists users.
// registerUser() lists first and only POSTs when the number is not yet an active user, so it is
// idempotent even if the server's own idempotency changes. Never logs full phone numbers.
import { z } from "zod";

export const SPECTRUM_BASE = "https://spectrum.photon.codes";

export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "expected E.164 like +19195550100");

/** User object as returned by POST /users/ and inside GET /users/ (OpenAPI "Spectrum Cloud External API"). */
export const UserSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: z.enum(["shared", "dedicated"]),
  phoneNumber: E164,
  assignedPhoneNumber: E164.nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  email: z.string().nullish(),
  meta: z.unknown().optional(),
  createdAt: z.string().nullish(),
});
export type SpectrumUser = z.infer<typeof UserSchema>;

export const SharedUserSchema = UserSchema.extend({ assignedPhoneNumber: E164 });
export type SharedUser = z.infer<typeof SharedUserSchema>;

const UserListSchema = z.object({ users: z.array(UserSchema), total: z.number().int().nonnegative() });

const Envelope = z.object({ succeed: z.boolean(), data: z.unknown() });

export interface ProjectCreds {
  projectId: string;
  projectSecret: string;
}

export class RegisterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly body?: string,
  ) {
    super(message);
    this.name = "RegisterError";
  }
}

/** Last 4 digits only, for logs. */
export function redact(phone: string | undefined | null): string {
  if (!phone) return "(none)";
  return `***${phone.slice(-4)}`;
}

/** Redacts every E.164 or long digit run inside free text (error bodies, messages). */
export function redactText(s: string): string {
  return s.replace(/\+\d{7,15}|(?<![\d.])\d{7,15}(?![\d.])/g, (m) => `***${m.slice(-4)}`);
}

export function basicAuth(creds: ProjectCreds): string {
  return "Basic " + Buffer.from(`${creds.projectId}:${creds.projectSecret}`).toString("base64");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CallOpts {
  attempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** One management API call with backoff on network errors, 429 and 5xx only. Returns envelope.data. */
async function call(creds: ProjectCreds, method: "GET" | "POST" | "DELETE", path: string, body: unknown, opts: CallOpts): Promise<unknown> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const f = opts.fetchImpl ?? fetch;
  const url = `${SPECTRUM_BASE}/projects/${creds.projectId}${path}`;
  let last: RegisterError | undefined;
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await f(url, {
        method,
        headers: {
          authorization: basicAuth(creds),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      last = new RegisterError(`${method} ${path}: network error: ${(e as Error).message}`, 0, true);
      await sleep(500 * 2 ** i);
      continue;
    }
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      if (method === "DELETE" && text.trim() === "") return undefined;
      return Envelope.parse(JSON.parse(text)).data;
    }
    const retryable = res.status === 429 || res.status >= 500;
    last = new RegisterError(`${method} ${path}: HTTP ${res.status}`, res.status, retryable, redactText(text.slice(0, 500)));
    if (!retryable) throw last;
    await sleep(500 * 2 ** i);
  }
  throw last ?? new RegisterError(`${method} ${path}: failed`, 0, true);
}

/** GET /projects/{id}/users/ (all pages, limit 500). */
export async function listUsers(creds: ProjectCreds, opts: CallOpts = {}): Promise<SpectrumUser[]> {
  const out: SpectrumUser[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = UserListSchema.parse(await call(creds, "GET", `/users/?limit=500&offset=${offset}`, undefined, opts));
    out.push(...page.users);
    if (page.users.length === 0 || out.length >= page.total) return out;
  }
}

/**
 * Low level: POST /projects/{id}/users/ { type: "shared", phoneNumber }. Returns the zod-validated
 * user including assignedPhoneNumber. Prefer registerUser(), which lists first.
 */
export async function registerSharedUser(creds: ProjectCreds, phoneNumber: string, opts: CallOpts = {}): Promise<SharedUser> {
  const phone = E164.parse(phoneNumber);
  return SharedUserSchema.parse(await call(creds, "POST", "/users/", { type: "shared", phoneNumber: phone }, opts));
}

/**
 * Idempotent registration: returns the existing user when `e164` is already registered on the
 * project, otherwise registers it. `created` tells the caller whether a POST happened.
 */
export async function ensureUser(
  creds: ProjectCreds,
  e164: string,
  opts: CallOpts = {},
): Promise<{ user: SharedUser; created: boolean }> {
  const phone = E164.parse(e164);
  const existing = (await listUsers(creds, opts)).find((u) => u.phoneNumber === phone);
  if (existing) {
    const parsed = SharedUserSchema.safeParse(existing);
    if (parsed.success) return { user: parsed.data, created: false };
  }
  return { user: await registerSharedUser(creds, phone, opts), created: true };
}

/** Registers `e164` on the project (if needed) and returns the pool number that texts it. */
export async function registerUser(projectId: string, projectSecret: string, e164: string): Promise<string> {
  return (await ensureUser({ projectId, projectSecret }, e164)).user.assignedPhoneNumber;
}

/** DELETE /projects/{id}/users/{userId}/ (soft delete). */
export async function deleteUser(creds: ProjectCreds, userId: string, opts: CallOpts = {}): Promise<void> {
  await call(creds, "DELETE", `/users/${encodeURIComponent(userId)}/`, undefined, opts);
}
