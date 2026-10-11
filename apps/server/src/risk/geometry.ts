// Geometry and fix quality (spec 7.2). Pure functions, no I/O.
import type { Fix, PlanType } from "../contracts.js";

export const EARTH_RADIUS_M = 6_371_008.8;
export const MAX_USABLE_ACCURACY_M = 200;
export const MAX_FIX_AGE_MS = 10 * 60_000;
export const ARRIVAL_MIN_SPAN_MS = 45_000;
export const DEPARTURE_MIN_SPAN_MS = 60_000;
export const SPEED_SEGMENT_MIN_MS = 60_000;
export const VEHICLE_SPEED_MPS = 7;
export const HYSTERESIS = 1.5;
export const HOME_RADIUS_M = 150;
export const DARK_AFTER_MS = 10 * 60_000;

export interface LatLng {
  lat: number;
  lng: number;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in meters. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point `meters` away from (lat, lng) along `bearingDeg` (0 = north, 90 = east). */
export function destinationPoint(lat: number, lng: number, meters: number, bearingDeg: number): LatLng {
  const d = meters / EARTH_RADIUS_M;
  const b = rad(bearingDeg);
  const p1 = rad(lat);
  const l1 = rad(lng);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lng: ((deg(l2) + 540) % 360) - 180 };
}

function hasCoords(f: Fix): boolean {
  return Number.isFinite(f.lat) && Number.isFinite(f.lng) && Math.abs(f.lat) <= 90 && Math.abs(f.lng) <= 180;
}

/** Quality part of "usable" (coordinates present, accuracy at most 200 m). */
export function hasUsableQuality(f: Fix): boolean {
  return hasCoords(f) && Number.isFinite(f.accuracyM) && f.accuracyM >= 0 && f.accuracyM <= MAX_USABLE_ACCURACY_M;
}

/** Usable fix (7.2): coordinates, accuracy at most 200 m, `at` within 10 min of now. */
export function isUsableFix(f: Fix, now: Date): boolean {
  return hasUsableQuality(f) && Math.abs(now.getTime() - f.at.getTime()) <= MAX_FIX_AGE_MS;
}

/** X1 (7.2 refinement): a fix implying more than this speed from the last accepted fix is an outlier. */
export const OUTLIER_MAX_SPEED_MPS = 50;
/** X1: a jump larger than 3 x accuracy + 150 m is an outlier when a following fix returns. */
export const OUTLIER_JUMP_BASE_M = 150;
/** X1: how many following fixes may show the return (two consecutive outliers are common at 3%). */
export const OUTLIER_LOOKAHEAD = 2;

export function outlierJumpM(f: Fix): number {
  return 3 * f.accuracyM + OUTLIER_JUMP_BASE_M;
}

/** Fixes that pass the quality bar, ascending by time, deduped on (at, lat, lng), outliers removed. */
export function qualityFixes(fixes: readonly Fix[]): Fix[] {
  const sorted = fixes.filter(hasUsableQuality).slice().sort((a, b) => a.at.getTime() - b.at.getTime());
  const deduped = sorted.filter((f, i) => {
    const p = sorted[i - 1];
    return !p || p.at.getTime() !== f.at.getTime() || p.lat !== f.lat || p.lng !== f.lng;
  });
  return rejectOutliers(deduped);
}

/**
 * X1 (7.2 refinement): drop a fix whose implied speed from the last accepted fix exceeds
 * 50 m/s, or whose jump from it exceeds 3 x accuracy + 150 m while one of the next two fixes
 * comes back within that distance of the last accepted fix. Trailing fixes (nothing after them
 * yet) are kept; detectDeparture asks for one more fix when a run starts with such a jump.
 */
export function rejectOutliers(q: readonly Fix[]): Fix[] {
  const out: Fix[] = [];
  for (let i = 0; i < q.length; i++) {
    const f = q[i]!;
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(f);
      continue;
    }
    const d = haversineM(prev, f);
    const dt = (f.at.getTime() - prev.at.getTime()) / 1000;
    if (dt > 0 && d / dt > OUTLIER_MAX_SPEED_MPS) continue;
    if (d > outlierJumpM(f)) {
      const next = q.slice(i + 1, i + 1 + OUTLIER_LOOKAHEAD);
      // A return is a later fix near the last accepted fix and nearer to it than to the suspect
      // (so ordinary walking progress is never mistaken for a return).
      if (next.some((n) => haversineM(n, prev) <= outlierJumpM(n) && haversineM(n, prev) < haversineM(n, f))) continue;
    }
    out.push(f);
  }
  return out;
}

export function latestUsableFix(fixes: readonly Fix[], now: Date): Fix | null {
  let best: Fix | null = null;
  for (const f of fixes) {
    if (f.at.getTime() > now.getTime() + 60_000) continue;
    if (!isUsableFix(f, now)) continue;
    if (!best || f.at > best.at) best = f;
  }
  return best;
}

/** Latest fix that has usable quality regardless of age (for guardian alerts, "last location at"). */
export function latestQualityFix(fixes: readonly Fix[]): Fix | null {
  const q = qualityFixes(fixes);
  return q[q.length - 1] ?? null;
}

export function venueBaseRadiusM(type: PlanType | null): number {
  switch (type) {
    case "marketplace":
      return 150;
    case "viewing":
      return 250;
    default:
      return 120;
  }
}

/** Geofence radius: max(base, 2 x accuracy). */
export function venueRadiusM(type: PlanType | null, accuracyM: number): number {
  return Math.max(venueBaseRadiusM(type), 2 * accuracyM);
}

export type Zone = "inside" | "outside" | "band";

/** X1 (7.2 refinement): hysteresis band is 0.5 x radius, capped so large geofences (viewing) still confirm departures within 3 fixes. */
export const HYSTERESIS_MAX_BAND_M = 60;

export function hysteresisBandM(radius: number): number {
  return Math.min(radius * (HYSTERESIS - 1), HYSTERESIS_MAX_BAND_M);
}

/** Inside: distance <= radius. Outside: distance > 1.5 x radius. Between: hysteresis band. */
export function zoneOf(f: Fix, center: LatLng, baseRadiusM: number): Zone {
  const radius = Math.max(baseRadiusM, 2 * f.accuracyM);
  const d = haversineM(f, center);
  if (d <= radius) return "inside";
  if (d > radius + hysteresisBandM(radius)) return "outside";
  return "band";
}

/**
 * Arrival (7.2): 2 consecutive usable fixes inside, at least 45 s apart. Returns the time of
 * the fix that completed the first such run, or null. Fixes before `since` are ignored.
 */
export function detectArrival(fixes: readonly Fix[], center: LatLng, baseRadiusM: number, since?: Date): Date | null {
  const q = qualityFixes(fixes).filter((f) => !since || f.at >= since);
  let runStart: Fix | null = null;
  for (const f of q) {
    if (zoneOf(f, center, baseRadiusM) === "inside") {
      if (!runStart) runStart = f;
      else if (f.at.getTime() - runStart.at.getTime() >= ARRIVAL_MIN_SPAN_MS) return f.at;
    } else {
      runStart = null;
    }
  }
  return null;
}

export interface Departure {
  /** First fix of the trailing outside run (when the user left). */
  leftAt: Date;
  /** Fix that confirmed the departure. */
  confirmedAt: Date;
}

/**
 * Departure (7.2): the trailing run of consecutive usable fixes is outside, has at least 2
 * fixes spanning at least 60 s, and an inside fix precedes it. The confirming fix must be fresh.
 */
export function detectDeparture(fixes: readonly Fix[], center: LatLng, baseRadiusM: number, now: Date): Departure | null {
  const q = qualityFixes(fixes).filter((f) => f.at.getTime() <= now.getTime() + 60_000);
  const last = q[q.length - 1];
  if (!last || !isUsableFix(last, now)) return null;
  let i = q.length - 1;
  while (i >= 0 && zoneOf(q[i]!, center, baseRadiusM) === "outside") i--;
  const runStartIdx = i + 1;
  const run = q.slice(runStartIdx);
  if (run.length < 2) return null;
  // X1: a run that starts with an outlier-sized jump AND whose first two fixes are also that far
  // apart looks like two trailing outliers no later fix has disproved yet; ask for a third
  // outside fix before calling it a departure.
  const before = q[runStartIdx - 1];
  const jumpy = (a: Fix, b: Fix) => haversineM(a, b) > outlierJumpM(b);
  // A vehicle moves steadily away (the second fix is farther by more than a jump); outliers do not.
  const recedes = haversineM(run[1]!, center) - haversineM(run[0]!, center) > outlierJumpM(run[1]!);
  if (before && run.length < 3 && jumpy(before, run[0]!) && jumpy(run[0]!, run[1]!) && !recedes) return null;
  if (last.at.getTime() - run[0]!.at.getTime() < DEPARTURE_MIN_SPAN_MS) return null;
  const hadInside = q.slice(0, runStartIdx).some((f) => zoneOf(f, center, baseRadiusM) === "inside");
  if (!hadInside) return null;
  return { leftAt: run[0]!.at, confirmedAt: last.at };
}

/**
 * Speeds (m/s) of the most recent segments between usable fixes at least 60 s apart, newest
 * first. Walks back from the latest fix to the nearest fix that is >= 60 s older, and so on.
 */
export function recentSegmentSpeeds(fixes: readonly Fix[], count = 2): number[] {
  const q = qualityFixes(fixes);
  const speeds: number[] = [];
  let endIdx = q.length - 1;
  while (endIdx > 0 && speeds.length < count) {
    const end = q[endIdx]!;
    let j = endIdx - 1;
    while (j >= 0 && end.at.getTime() - q[j]!.at.getTime() < SPEED_SEGMENT_MIN_MS) j--;
    if (j < 0) break;
    const start = q[j]!;
    const dt = (end.at.getTime() - start.at.getTime()) / 1000;
    speeds.push(haversineM(start, end) / dt);
    endIdx = j;
  }
  return speeds;
}

/** Vehicle speed (7.2): >= 7 m/s on 2 consecutive segments. */
export function isVehicleSpeed(fixes: readonly Fix[]): boolean {
  const s = recentSegmentSpeeds(fixes, 2);
  return s.length === 2 && s.every((v) => v >= VEHICLE_SPEED_MPS - 1e-6);
}

/**
 * Dark (7.2): no usable fix for 10 min. `reference` is when fixes were first expected
 * (share confirmed or plan start), so a plan that never got a fix goes dark 10 min after it.
 */
export function isDark(fixes: readonly Fix[], now: Date, reference: Date): boolean {
  const last = latestUsableFix(fixes, now);
  const since = last ? Math.max(last.at.getTime(), reference.getTime()) : reference.getTime();
  return now.getTime() - since >= DARK_AFTER_MS;
}

/** Minutes since the latest usable-quality fix, or null if none. */
export function minutesSinceLastFix(fixes: readonly Fix[], now: Date): number | null {
  const f = latestQualityFix(fixes);
  return f ? Math.max(0, Math.round((now.getTime() - f.at.getTime()) / 60_000)) : null;
}

export interface Stay {
  center: LatLng;
  since: Date;
}

/**
 * A stay at a new spot (T-VENUE-CHG): every quality fix in the last `minStayMs` (and at least
 * 3 of them, spanning the whole period) is outside the venue geofence, and at least 80% lie
 * within `stayRadiusM` of their median point. Returns the stay center or null.
 */
export function detectStay(
  fixes: readonly Fix[],
  now: Date,
  venue: LatLng,
  baseRadiusM: number,
  minStayMs = 10 * 60_000,
  stayRadiusM = 150,
): Stay | null {
  const q = qualityFixes(fixes).filter((f) => f.at.getTime() <= now.getTime());
  const cutoff = now.getTime() - minStayMs;
  const window = q.filter((f) => f.at.getTime() >= cutoff);
  const before = q.filter((f) => f.at.getTime() < cutoff);
  if (window.length < 3) return null;
  const last = window[window.length - 1]!;
  if (!isUsableFix(last, now)) return null;
  // The stay must cover the full period: the fix just before the window is also away.
  const prev = before[before.length - 1];
  if (!prev || zoneOf(prev, venue, baseRadiusM) === "inside") return null;
  const span = [prev, ...window];
  const center = { lat: median(span.map((f) => f.lat)), lng: median(span.map((f) => f.lng)) };
  const near = span.filter((f) => haversineM(f, center) <= Math.max(stayRadiusM, 2 * f.accuracyM));
  if (near.length / span.length < 0.8) return null;
  if (zoneOf({ ...last, ...center, accuracyM: 0 }, venue, baseRadiusM) !== "outside") return null;
  const insideCount = span.filter((f) => zoneOf(f, venue, baseRadiusM) === "inside").length;
  if (insideCount > span.length * 0.2) return null;
  return { center, since: prev.at };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Home geofence is stored coarsely: rounded to 3 decimals (7.2). */
export function coarsenCoord(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Night hours: 22:00 to 05:00 local (6.4). */
export function isNightHours(now: Date, timeZone: string): boolean {
  const hour = localHour(now, timeZone);
  return hour >= 22 || hour < 5;
}

export function localHour(now: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" });
  const h = Number(fmt.formatToParts(now).find((p) => p.type === "hour")?.value ?? "0");
  return h === 24 ? 0 : h;
}
