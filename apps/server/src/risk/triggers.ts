// Risk triggers (spec 7.3): deterministic rules over the plan, the clock, and the user's fixes.
// No ML, no LLM (I7). Pure: callers pass every input.
import type { Fix, PlanState, Transport, TriggerId } from "../contracts.js";
import { CLASS_RANK, TRIGGER_CLASS, type TriggerClass } from "../plan/ladder.js";
import type { EnginePlan } from "../plan/types.js";
import {
  detectArrival,
  detectDeparture,
  detectStay,
  haversineM,
  isDark,
  isVehicleSpeed,
  latestUsableFix,
  venueBaseRadiusM,
  zoneOf,
  type LatLng,
} from "./geometry.js";

export const FAR_DISTANCE_M = 5_000;
export const NOARRIVE_AFTER_MS = 20 * 60_000;
export const DEPARTURE_END_MARGIN_MS = 10 * 60_000;
export const VENUE_CHANGE_MAX_M = 2_000;
const CAR_UNEXPECTED: readonly Transport[] = ["walk", "transit", "rideshare"];

export interface FiredTrigger {
  id: TriggerId;
  cls: TriggerClass;
  /** For T-VENUE-CHG: the new spot. */
  spot?: LatLng;
}

/** Evaluation order; ties in class rank resolve to the earlier entry. */
export const TRIGGER_PRIORITY: readonly TriggerId[] = [
  "T-DEP-CAR-THEIRS",
  "T-DEP-CAR",
  "T-FAR",
  "T-DARK",
  "T-DEP-WALK",
  "T-NOARRIVE",
  "T-POST-EXIT",
  "T-MKT-LONG",
  "T-OVR",
  "T-VENUE-CHG",
];

/** States in which any trigger may fire (7.3). PRE_MEETUP only for T-NOARRIVE, from start. */
const TRIGGER_STATES: readonly PlanState[] = ["ACTIVE", "OVERTIME", "CHECKING"];

/**
 * The phase the plan is really in: CHECKING is ACTIVE before end + grace and OVERTIME after.
 * Returns null when triggers must not fire.
 */
export function effectivePhase(plan: EnginePlan, now: Date): "ACTIVE" | "OVERTIME" | null {
  if (plan.state === "ACTIVE" || plan.state === "OVERTIME") return plan.state;
  if (plan.state === "CHECKING") {
    if (!plan.endAt) return "ACTIVE";
    return now.getTime() >= plan.endAt.getTime() + plan.graceMin * 60_000 ? "OVERTIME" : "ACTIVE";
  }
  if (plan.state === "PRE_MEETUP" && plan.startAt && now >= plan.startAt) return "ACTIVE";
  return null;
}

/** Location is live: Find My mode with an accepted share. Pins and time-only mode never are. */
export function locationLive(plan: EnginePlan): boolean {
  return plan.locationMode === "findmy" && plan.shareConfirmedAt !== null;
}

export function isSuppressed(plan: EnginePlan, id: TriggerId, now: Date): boolean {
  const until = plan.suppressedUntil[id];
  return until !== undefined && new Date(until).getTime() > now.getTime();
}

function venueOf(plan: EnginePlan): LatLng | null {
  return plan.venueLat !== null && plan.venueLng !== null ? { lat: plan.venueLat, lng: plan.venueLng } : null;
}

export interface EvaluateOptions {
  /** Trigger ids to skip (the engine handles T-OVR with the end_grace timer). */
  exclude?: readonly TriggerId[];
}

/**
 * Every trigger whose condition holds now, sorted by class rank (highest first) then
 * TRIGGER_PRIORITY. Respects state gating, time-only mode, and 20-min suppression.
 */
export function evaluateTriggers(plan: EnginePlan, now: Date, fixes: readonly Fix[], opts: EvaluateOptions = {}): FiredTrigger[] {
  if (!TRIGGER_STATES.includes(plan.state) && plan.state !== "PRE_MEETUP") return [];
  const phase = effectivePhase(plan, now);
  if (!phase) return [];
  const exclude = new Set(opts.exclude ?? []);
  const fired: FiredTrigger[] = [];
  const add = (id: TriggerId, extra: Partial<FiredTrigger> = {}) => {
    if (exclude.has(id) || isSuppressed(plan, id, now)) return;
    fired.push({ id, cls: TRIGGER_CLASS[id], ...extra });
  };
  const preMeetup = plan.state === "PRE_MEETUP";
  const endMs = plan.endAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const startMs = plan.startAt?.getTime() ?? null;

  // Time-based rules (allowed in time-only mode).
  if (!preMeetup && phase === "ACTIVE" && plan.endAt && now.getTime() > endMs + plan.graceMin * 60_000) add("T-OVR");
  if (!preMeetup && plan.type === "marketplace" && phase === "ACTIVE" && startMs !== null && plan.endAt) {
    const duration = endMs - startMs;
    if (now.getTime() >= startMs + 2 * duration) add("T-MKT-LONG");
  }

  // Location rules: never in time-only mode (7.3).
  if (locationLive(plan)) {
    const venue = venueOf(plan);
    const base = venueBaseRadiusM(plan.type);
    const latest = latestUsableFix(fixes, now);

    if (venue && startMs !== null && phase === "ACTIVE" && now.getTime() >= startMs + NOARRIVE_AFTER_MS) {
      const arrived = plan.arrivedAt !== null || detectArrival(fixes, venue, base) !== null;
      if (!arrived && latest) add("T-NOARRIVE");
    }

    if (!preMeetup) {
      if (venue) {
        const dep = detectDeparture(fixes, venue, base, now);
        const fresh = dep && (!plan.lastResolvedAt || dep.leftAt.getTime() > plan.lastResolvedAt.getTime());
        if (dep && fresh) {
          const vehicle = isVehicleSpeed(fixes.filter((f) => f.at.getTime() >= dep.leftAt.getTime() - 120_000));
          // "Departure before planned end - 10 min" is judged by when the user left, not by
          // when two outside fixes confirmed it (about a minute later).
          const beforeEnd = phase === "ACTIVE" && dep.leftAt.getTime() < endMs - DEPARTURE_END_MARGIN_MS;
          if (vehicle && plan.transport && CAR_UNEXPECTED.includes(plan.transport)) add("T-DEP-CAR-THEIRS");
          if (vehicle && beforeEnd) add("T-DEP-CAR");
          // Dates: walking to a nearby spot is common (4.4.1); T-VENUE-CHG covers it instead.
          if (!vehicle && beforeEnd && plan.type !== "date") add("T-DEP-WALK");
        }
        if (phase === "ACTIVE" && latest && haversineM(latest, venue) > FAR_DISTANCE_M) add("T-FAR");
        if (plan.type === "date" && phase === "ACTIVE" && plan.state === "ACTIVE" && !plan.pendingSpot && plan.arrivedAt) {
          const stay = detectStay(fixes, now, venue, base);
          if (stay && haversineM(stay.center, venue) <= VENUE_CHANGE_MAX_M) add("T-VENUE-CHG", { spot: stay.center });
        }
      }
      const shareLive = !plan.shareExpiresAt || plan.shareExpiresAt.getTime() > now.getTime();
      if (shareLive) {
        const ref = Math.max(plan.shareConfirmedAt?.getTime() ?? 0, startMs ?? 0);
        if (isDark(fixes, now, new Date(ref))) add("T-DARK");
      }
    }
  }

  return sortTriggers(fired);
}

export function sortTriggers(list: FiredTrigger[]): FiredTrigger[] {
  const rank = (c: TriggerClass) => (c === "info" ? -1 : CLASS_RANK[c]);
  return [...list].sort((a, b) => rank(b.cls) - rank(a.cls) || TRIGGER_PRIORITY.indexOf(a.id) - TRIGGER_PRIORITY.indexOf(b.id));
}

/**
 * T-POST-EXIT (7.3, 6.6 step 4): 10 min after the exit word, the user is still inside the
 * venue geofence. Returns "inside" (fire), "left", or "unknown" (time-only or no usable fix).
 */
export function postExitStatus(plan: EnginePlan, now: Date, fixes: readonly Fix[]): "inside" | "left" | "unknown" {
  const venue = venueOf(plan);
  if (!locationLive(plan) || !venue) return "unknown";
  const latest = latestUsableFix(fixes, now);
  if (!latest) return "unknown";
  return zoneOf(latest, venue, venueBaseRadiusM(plan.type)) === "outside" ? "left" : "inside";
}
