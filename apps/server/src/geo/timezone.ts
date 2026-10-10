// Timezone helpers (spec 4.4.5). Times are stored in UTC and rendered in the user's timezone.
// Source order: explicit user statement, first location fix (geo-tz), DEFAULT_TZ.
import { find } from "geo-tz";

export const FALLBACK_TZ = "America/New_York";

export function isValidTz(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** IANA timezone at a coordinate, or null when the lookup has no answer. */
export function tzForCoords(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  try {
    const zones = find(lat, lng);
    const z = zones[0];
    return z && isValidTz(z) ? z : null;
  } catch {
    return null;
  }
}

export function resolveTz(opts: {
  explicit?: string | null;
  fix?: { lat: number; lng: number } | null;
  defaultTz?: string | null;
}): string {
  if (isValidTz(opts.explicit)) return opts.explicit;
  if (opts.fix) {
    const t = tzForCoords(opts.fix.lat, opts.fix.lng);
    if (t) return t;
  }
  return isValidTz(opts.defaultTz) ? opts.defaultTz : FALLBACK_TZ;
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall-clock components of an instant in a timezone. */
export function wallTime(at: Date, tz: string): WallTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

/** Offset of `tz` from UTC at `at`, in minutes (e.g. -240 for EDT). */
export function offsetMinutes(at: Date, tz: string): number {
  const w = wallTime(at, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const truncated = Math.floor(at.getTime() / 60000) * 60000;
  return Math.round((asUtc - truncated) / 60000);
}

/** UTC instant for a wall-clock time in `tz`. Handles DST by re-checking the offset. */
export function zonedWallTimeToUtc(
  w: { year: number; month: number; day: number; hour: number; minute: number },
  tz: string,
): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  let off = offsetMinutes(new Date(guess), tz);
  let result = guess - off * 60000;
  const off2 = offsetMinutes(new Date(result), tz);
  if (off2 !== off) {
    off = off2;
    result = guess - off * 60000;
  }
  return new Date(result);
}

/** "7:00 PM" */
export function formatClock(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
    .format(at)
    .replace(/ | /g, " ");
}

/** "Sat 7:00 PM" (spec 4.4.5: always confirm times with day and clock time). */
export function formatDayTime(at: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(at);
  return `${day} ${formatClock(at, tz)}`;
}

/** "7:00 to 9:00 PM" or "11:30 AM to 1:00 PM". */
export function formatClockRange(start: Date, end: Date, tz: string): string {
  const a = formatClock(start, tz);
  const b = formatClock(end, tz);
  const ma = a.slice(-2);
  const mb = b.slice(-2);
  return ma === mb ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
}

/** Night hours for ladder timing (spec 6.4): 22:00 to 05:00 local. */
export function isNight(at: Date, tz: string): boolean {
  const h = wallTime(at, tz).hour;
  return h >= 22 || h < 5;
}
