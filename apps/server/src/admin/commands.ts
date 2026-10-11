// Admin commands (spec 15.4, 19). Pure parsing into a typed result; no I/O.
// Only numbers in ADMIN_NUMBERS may use them. /ff works only with DEMO_MODE or TEST_MODE.

export interface AdminConfig {
  /** Exact E.164 numbers from ADMIN_NUMBERS. */
  adminNumbers: readonly string[];
  demoMode: boolean;
  testMode: boolean;
}

export const MAX_FF_MINUTES = 24 * 60;

export type AdminCommand =
  | { kind: "ff"; minutes: number }
  | { kind: "status" }
  | { kind: "users" }
  /** Sender is not an admin: handle the text as an ordinary message. */
  | { kind: "not_admin" }
  /** Admin, but the command is not allowed in this mode. */
  | { kind: "denied"; command: string; reason: "ff_requires_demo_or_test_mode" }
  | { kind: "invalid"; command: string; usage: string }
  | { kind: "unknown"; command: string };

/** Split ADMIN_NUMBERS ("+1312..., +1919...") into exact numbers. */
export function parseAdminNumbers(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\+[1-9]\d{6,14}$/.test(s));
}

export function isAdmin(from: string, cfg: AdminConfig): boolean {
  return cfg.adminNumbers.includes(from);
}

/**
 * Parse an inbound text. Returns null when the text is not slash-command shaped, so the
 * normal pipeline handles it. Admin commands never run for non-admin senders.
 */
export function parseAdminCommand(text: string, from: string, cfg: AdminConfig): AdminCommand | null {
  const trimmed = text.trim();
  const m = /^\/([a-z]+)\b\s*(.*)$/i.exec(trimmed);
  if (!m) return null;
  if (!isAdmin(from, cfg)) return { kind: "not_admin" };
  const command = m[1]!.toLowerCase();
  const arg = m[2]!.trim();
  switch (command) {
    case "ff": {
      if (!cfg.demoMode && !cfg.testMode) return { kind: "denied", command, reason: "ff_requires_demo_or_test_mode" };
      const usage = `/ff <minutes> (1 to ${MAX_FF_MINUTES})`;
      if (!/^\d+$/.test(arg)) return { kind: "invalid", command, usage };
      const minutes = Number(arg);
      if (minutes < 1 || minutes > MAX_FF_MINUTES) return { kind: "invalid", command, usage };
      return { kind: "ff", minutes };
    }
    case "status":
      return arg ? { kind: "invalid", command, usage: "/status" } : { kind: "status" };
    case "users":
      return arg ? { kind: "invalid", command, usage: "/users" } : { kind: "users" };
    default:
      return { kind: "unknown", command };
  }
}
