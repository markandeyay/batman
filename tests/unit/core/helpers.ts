// Shared builders for core unit tests.
import type { Fix, Plan } from "../../../apps/server/src/contracts.js";
import { newEnginePlan, type EngineContext, type EnginePlan } from "../../../apps/server/src/plan/types.js";
import { destinationPoint } from "../../../apps/server/src/risk/geometry.js";

export const T0 = new Date("2026-10-10T23:00:00Z"); // 19:00 New York (EDT), not night
export const MIN = 60_000;

export function at(minutesFromT0: number, base = T0): Date {
  return new Date(base.getTime() + minutesFromT0 * MIN);
}

export const VENUE = { lat: 41.9172, lng: -87.7067 };

export function basePlan(overrides: Partial<EnginePlan> = {}): EnginePlan {
  const p: Plan = {
    id: "plan-1",
    userId: "user-1",
    guardianId: "gdn-1",
    state: "DRAFT",
    type: "date",
    startAt: T0,
    endAt: at(120),
    graceMin: 15,
    venueText: "Lula Cafe",
    venueLat: VENUE.lat,
    venueLng: VENUE.lng,
    venuePlaceType: "cafe",
    counterpartName: "Jordan",
    counterpartSource: "Hinge",
    transport: "self_drive",
    firstTimeInPerson: true,
    buyOrSell: null,
    privateAddress: null,
    userNervous: false,
    highVigilance: false,
    notifyGuardianStartEnd: false,
    locationMode: "findmy",
    ladderStep: null,
    ladderClass: null,
    ladderTrigger: null,
    ladderStartedAt: null,
    escalatedAt: null,
    escalationReason: null,
    guardianAckAt: null,
    arrivedAt: null,
    arrivalLineSent: false,
    totalExtensionMin: 0,
    suppressedUntil: {},
    exitWordAt: null,
    closedAt: null,
    createdAt: at(-240),
    updatedAt: at(-240),
  };
  return { ...newEnginePlan(p), ...overrides };
}

export function ctxAt(now: Date, overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    now,
    user: { displayName: "Alex", homeLat: null, homeLng: null, decoyCaller: "roommate" },
    guardian: { displayName: "Priya", linkStatus: "accepted", stopped: false },
    timeZone: "America/New_York",
    fixes: [],
    ...overrides,
  };
}

export function fixAt(time: Date, lat: number, lng: number, accuracyM = 20, extra: Partial<Fix> = {}): Fix {
  return { lat, lng, accuracyM, at: time, locationType: "live", expiresAt: null, source: "findmy", ...extra };
}

/** A fix `meters` from the venue toward `bearingDeg`. */
export function fixFromVenue(time: Date, meters: number, bearingDeg = 90, accuracyM = 20): Fix {
  const p = destinationPoint(VENUE.lat, VENUE.lng, meters, bearingDeg);
  return fixAt(time, p.lat, p.lng, accuracyM);
}
