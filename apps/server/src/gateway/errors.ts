// Error classification for Photon calls (spec 8.5, 11.3; PHOTON_NOTES B and addenda).
//
// Rule: retry only when the error says it is retryable. Two live findings are hard
// non-retryable regardless of what the SDK says:
//   - PERMISSION_DENIED "Target not allowed for this project": on the shared pool a person must
//     text Batman first before any send or advanced-imessage call targeting them is allowed.
//   - ValidationError "Target is a Photon-managed shared line": pool numbers are not recipients.
// Both surface as typed errors so the dialogue can tell the user (for example "Priya hasn't
// texted me yet").
import { redactPhones } from "../util/log.js";

/** gRPC status codes we branch on. */
export const GRPC = {
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

export type ErrorKind =
  | "target_not_allowed" // recipient has not texted Batman yet (shared pool)
  | "pool_number" // recipient is a Photon pool line
  | "not_found"
  | "rate_limited"
  | "quota" // our own daily cap (QuotaExceededError)
  | "stopped" // recipient texted STOP (I14)
  | "emergency_number" // I6
  | "auth"
  | "validation"
  | "connection"
  | "unknown";

export interface ErrorInfo {
  kind: ErrorKind;
  retryable: boolean;
  grpcCode?: number;
  code?: string;
  /** Redacted message, safe to log. */
  message: string;
  /** Server suggested wait, ms. */
  retryAfterMs?: number;
}

const TARGET_NOT_ALLOWED_RE = /target not allowed/i;
const POOL_NUMBER_RE = /photon-managed shared line|not a valid recipient/i;
const SHARE_ENDED_RE = /not currently sharing/i;

interface ErrLike {
  message?: unknown;
  grpcCode?: unknown;
  code?: unknown;
  retryable?: unknown;
  retryAfter?: unknown;
  name?: unknown;
}

export function describeError(err: unknown): ErrorInfo {
  const e = (err && typeof err === "object" ? err : {}) as ErrLike;
  const message = redactPhones(typeof e.message === "string" ? e.message : String(err));
  const grpcCode = typeof e.grpcCode === "number" ? e.grpcCode : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;
  const base: Omit<ErrorInfo, "kind" | "retryable"> = { message };
  if (grpcCode !== undefined) base.grpcCode = grpcCode;
  if (code !== undefined) base.code = code;
  if (typeof e.retryAfter === "number" && e.retryAfter > 0) base.retryAfterMs = e.retryAfter * 1000;

  if (err instanceof GatewayError) return { ...base, kind: err.kind, retryable: false };
  if (TARGET_NOT_ALLOWED_RE.test(message)) return { ...base, kind: "target_not_allowed", retryable: false };
  if (POOL_NUMBER_RE.test(message)) return { ...base, kind: "pool_number", retryable: false };
  switch (grpcCode) {
    case GRPC.PERMISSION_DENIED:
    case GRPC.UNAUTHENTICATED:
      return { ...base, kind: "auth", retryable: false };
    case GRPC.INVALID_ARGUMENT:
    case GRPC.FAILED_PRECONDITION:
      return { ...base, kind: "validation", retryable: false };
    case GRPC.NOT_FOUND:
      return { ...base, kind: "not_found", retryable: false };
    case GRPC.RESOURCE_EXHAUSTED:
      return { ...base, kind: "rate_limited", retryable: e.retryable === true };
    case GRPC.UNAVAILABLE:
    case GRPC.DEADLINE_EXCEEDED:
    case GRPC.ABORTED:
    case GRPC.INTERNAL:
      return { ...base, kind: "connection", retryable: e.retryable !== false };
    default:
      break;
  }
  if (typeof e.retryable === "boolean") return { ...base, kind: e.retryable ? "connection" : "unknown", retryable: e.retryable };
  // Plain network failures (fetch, socket resets) carry no gRPC status: retry them.
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network/i.test(message)) {
    return { ...base, kind: "connection", retryable: true };
  }
  return { ...base, kind: "unknown", retryable: false };
}

export function isRetryable(err: unknown): boolean {
  return describeError(err).retryable;
}

/** get() NOT_FOUND "[upstream] Address is not currently sharing a location" (S1 movement test). */
export function isShareEnded(err: unknown): boolean {
  const i = describeError(err);
  return i.kind === "not_found" && SHARE_ENDED_RE.test(i.message);
}

export function isNotFound(err: unknown): boolean {
  const e = err as ErrLike | null;
  return !!e && (e.grpcCode === GRPC.NOT_FOUND || (typeof e.name === "string" && e.name === "NotFoundError"));
}

/** Typed, non-retryable send failure the dialogue can branch on. */
export class GatewayError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GatewayError";
  }
}

/** The recipient must text Batman first (shared pool rule). */
export class TargetNotAllowedError extends GatewayError {
  constructor(readonly toLast4: string, options?: { cause?: unknown }) {
    super("target_not_allowed", `recipient ***${toLast4} has not texted Batman yet`, options);
    this.name = "TargetNotAllowedError";
  }
}

export class PoolNumberError extends GatewayError {
  constructor(readonly toLast4: string, options?: { cause?: unknown }) {
    super("pool_number", `recipient ***${toLast4} is a Photon pool line, not a person`, options);
    this.name = "PoolNumberError";
  }
}

export class QuotaExceededError extends GatewayError {
  constructor(readonly counter: string) {
    super("quota", `daily quota near cap (${counter}); only safety-critical sends proceed`);
    this.name = "QuotaExceededError";
  }
}

export class StoppedRecipientError extends GatewayError {
  constructor(readonly toLast4: string) {
    super("stopped", `recipient ***${toLast4} texted STOP; send dropped (I14)`);
    this.name = "StoppedRecipientError";
  }
}

export class EmergencyNumberError extends GatewayError {
  constructor() {
    super("emergency_number", "refusing to contact an emergency number (I6)");
    this.name = "EmergencyNumberError";
  }
}

/** Turn a raw send error into a typed one when we recognize it. */
export function toTypedError(err: unknown, to: string): unknown {
  if (err instanceof GatewayError) return err;
  const info = describeError(err);
  const last4 = to.replace(/\D/g, "").slice(-4);
  if (info.kind === "target_not_allowed") return new TargetNotAllowedError(last4, { cause: err });
  if (info.kind === "pool_number") return new PoolNumberError(last4, { cause: err });
  return err;
}

const EMERGENCY_SHORT = new Set(["911", "112", "999", "000", "110", "119", "100", "101", "102", "108", "118", "933", "988"]);

/**
 * I6: Batman never texts or calls emergency services. Blocks short emergency codes in any form
 * and NANP N11 service codes dressed up as E.164 (+1911..., +1211...).
 */
export function isEmergencyNumber(address: string): boolean {
  const digits = address.replace(/\D/g, "");
  if (digits.length <= 4) return true; // short codes are never a person
  if (EMERGENCY_SHORT.has(digits)) return true;
  if (digits.startsWith("1") && EMERGENCY_SHORT.has(digits.slice(1))) return true;
  if (/^1[2-9]11/.test(digits)) return true;
  return false;
}

export const last4 = (s: string): string => `***${s.replace(/\D/g, "").slice(-4)}`;
