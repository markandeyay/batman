import { describe, expect, it } from "vitest";
import type { Fix } from "../../../apps/server/src/contracts.js";
import { destinationPoint } from "../../../apps/server/src/risk/geometry.js";
import { effectivePhase, evaluateTriggers, postExitStatus, sortTriggers } from "../../../apps/server/src/risk/triggers.js";
import type { EnginePlan } from "../../../apps/server/src/plan/types.js";
import { VENUE, at, basePlan, fixAt, fixFromVenue } from "./helpers.js";

/** An ACTIVE plan with a live Find My share, arrived at T0+2. */
function active(overrides: Partial<EnginePlan> = {}): EnginePlan {
  return basePlan({ state: "ACTIVE", shareConfirmedAt: at(-25), arrivedAt: at(2), ...overrides });
}

/** Fixes inside the venue every minute from `from` to `to` minutes. */
function insideFixes(from: number, to: number): Fix[] {
  const out: Fix[] = [];
  for (let m = from; m <= to; m++) out.push(fixFromVenue(at(m), 15, (m * 37) % 360));
  return out;
}

/** Leave the venue at `leaveMin` going east at `mps` meters per second, a fix per minute. */
function departFixes(leaveMin: number, mps: number, minutes: number): Fix[] {
  const out: Fix[] = [];
  for (let i = 1; i <= minutes; i++) out.push(fixFromVenue(at(leaveMin + i), 100 + mps * 60 * i, 90));
  return out;
}

const ids = (list: { id: string }[]) => list.map((t) => t.id);

describe("state gating (7.3)", () => {
  it("never fires in DRAFT, ARMED, CLOSED, CANCELLED, EXPIRED, CLOSING, ESCALATED", () => {
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 10, 3)];
    for (const state of ["DRAFT", "ARMED", "CLOSED", "CANCELLED", "EXPIRED", "CLOSING", "ESCALATED", "AWAITING_GUARDIAN"] as const) {
      expect(evaluateTriggers(active({ state }), at(33), fixes), state).toEqual([]);
    }
  });

  it("PRE_MEETUP only allows T-NOARRIVE, and only from start", () => {
    const far = [fixFromVenue(at(19), 2000), fixFromVenue(at(20), 2000)];
    expect(ids(evaluateTriggers(active({ state: "PRE_MEETUP", arrivedAt: null }), at(20), far))).toEqual(["T-NOARRIVE"]);
    expect(evaluateTriggers(active({ state: "PRE_MEETUP", arrivedAt: null, startAt: at(30), endAt: at(150) }), at(20), far)).toEqual([]);
  });

  it("CHECKING evaluates as ACTIVE before end+grace and OVERTIME after", () => {
    expect(effectivePhase(active({ state: "CHECKING" }), at(100))).toBe("ACTIVE");
    expect(effectivePhase(active({ state: "CHECKING" }), at(136))).toBe("OVERTIME");
  });
});

describe("T-OVR", () => {
  it("fires after end + grace while ACTIVE", () => {
    expect(ids(evaluateTriggers(active({ locationMode: "none", shareConfirmedAt: null }), at(135.1), []))).toEqual(["T-OVR"]);
    expect(evaluateTriggers(active({ locationMode: "none", shareConfirmedAt: null }), at(135), [])).toEqual([]);
  });

  it("can be excluded", () => {
    expect(evaluateTriggers(active({ locationMode: "none" }), at(140), [], { exclude: ["T-OVR"] })).toEqual([]);
  });
});

describe("departure triggers", () => {
  it("T-DEP-WALK: walking departure before end - 10 (non-date)", () => {
    const p = active({ type: "other", transport: "self_drive" });
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 1.4, 3)];
    expect(ids(evaluateTriggers(p, at(33), fixes))).toEqual(["T-DEP-WALK"]);
  });

  it("T-DEP-WALK does not fire for dates (T-VENUE-CHG covers walking off)", () => {
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 1.4, 3)];
    expect(evaluateTriggers(active({ type: "date" }), at(33), fixes)).toEqual([]);
  });

  it("T-DEP-WALK does not fire when the user left within 10 min of planned end", () => {
    const p = active({ type: "other", endAt: at(40) });
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 1.4, 3)];
    expect(evaluateTriggers(p, at(33), fixes)).toEqual([]);
  });

  it("the end margin is judged by when the user left, not when it was confirmed", () => {
    // Leaves at 29 (first outside fix), confirmed at 31; end - 10 = 30.
    const p = active({ type: "other", endAt: at(40) });
    const fixes = [...insideFixes(0, 28), ...departFixes(28, 1.4, 3)];
    expect(ids(evaluateTriggers(p, at(31), fixes))).toEqual(["T-DEP-WALK"]);
  });

  it("T-DEP-CAR: vehicle-speed departure before end - 10", () => {
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 12, 3)];
    expect(ids(evaluateTriggers(active({ transport: "self_drive" }), at(33), fixes))).toEqual(["T-DEP-CAR"]);
  });

  it("T-DEP-CAR-THEIRS: vehicle speed when the user walked, took transit, or rideshare", () => {
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 12, 3)];
    for (const transport of ["walk", "transit", "rideshare"] as const) {
      expect(ids(evaluateTriggers(active({ transport }), at(33), fixes))).toEqual(["T-DEP-CAR-THEIRS", "T-DEP-CAR"]);
    }
  });

  it("T-DEP-CAR-THEIRS still fires near the end; T-DEP-CAR does not", () => {
    const p = active({ transport: "walk", endAt: at(40) });
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 12, 3)];
    expect(ids(evaluateTriggers(p, at(33), fixes))).toEqual(["T-DEP-CAR-THEIRS"]);
  });

  it("departures already acknowledged (before lastResolvedAt) do not refire", () => {
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 12, 3)];
    expect(evaluateTriggers(active({ lastResolvedAt: at(32) }), at(33), fixes)).toEqual([]);
  });

  it("no departure without venue coordinates", () => {
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 12, 3)];
    expect(evaluateTriggers(active({ venueLat: null, venueLng: null }), at(33), fixes)).toEqual([]);
  });
});

describe("T-FAR", () => {
  it("fires beyond 5 km from the venue", () => {
    const fixes = [fixFromVenue(at(59), 5100), fixFromVenue(at(60), 5100)];
    expect(ids(evaluateTriggers(active({ type: "date" }), at(60), fixes))).toContain("T-FAR");
  });

  it("does not fire at 4.9 km", () => {
    const fixes = [fixFromVenue(at(60), 4900)];
    expect(ids(evaluateTriggers(active(), at(60), fixes))).not.toContain("T-FAR");
  });
});

describe("T-DARK", () => {
  it("fires after 10 min with no usable fix while the share is live", () => {
    const fixes = insideFixes(0, 30);
    expect(evaluateTriggers(active(), at(39.9), fixes)).toEqual([]);
    expect(ids(evaluateTriggers(active(), at(40), fixes))).toEqual(["T-DARK"]);
  });

  it("does not fire once the share has expired", () => {
    expect(evaluateTriggers(active({ shareExpiresAt: at(35) }), at(45), insideFixes(0, 30))).toEqual([]);
  });

  it("fires in OVERTIME", () => {
    expect(ids(evaluateTriggers(active({ state: "OVERTIME" }), at(150), insideFixes(0, 130)))).toEqual(["T-DARK"]);
  });

  it("counts from start when the share never produced a fix", () => {
    expect(ids(evaluateTriggers(active({ arrivedAt: null, venueLat: null, venueLng: null }), at(10), []))).toEqual(["T-DARK"]);
  });
});

describe("T-NOARRIVE", () => {
  const far = [fixFromVenue(at(19), 1500), fixFromVenue(at(20), 1500)];
  it("fires at start + 20 without arrival while location is live", () => {
    expect(ids(evaluateTriggers(active({ arrivedAt: null }), at(20), far))).toEqual(["T-NOARRIVE"]);
    expect(evaluateTriggers(active({ arrivedAt: null }), at(19.9), far)).toEqual([]);
  });

  it("does not fire when arrival is visible in the fixes", () => {
    expect(evaluateTriggers(active({ arrivedAt: null }), at(20), insideFixes(10, 20))).toEqual([]);
  });

  it("does not fire without a usable fix (dark handles that)", () => {
    expect(ids(evaluateTriggers(active({ arrivedAt: null }), at(20), []))).toEqual(["T-DARK"]);
  });
});

describe("T-MKT-LONG", () => {
  it("fires for marketplace at 2x planned duration, even in time-only mode", () => {
    const p = active({ type: "marketplace", endAt: at(20), graceMin: 5, locationMode: "none", shareConfirmedAt: null });
    expect(evaluateTriggers(p, at(39.9), [], { exclude: ["T-OVR"] })).toEqual([]);
    expect(ids(evaluateTriggers(p, at(40), [], { exclude: ["T-OVR"] }))).toEqual(["T-MKT-LONG"]);
  });

  it("does not apply to other types", () => {
    const p = active({ type: "viewing", endAt: at(20), locationMode: "none" });
    expect(evaluateTriggers(p, at(40), [], { exclude: ["T-OVR"] })).toEqual([]);
  });
});

describe("T-VENUE-CHG", () => {
  const bar = destinationPoint(VENUE.lat, VENUE.lng, 400, 45);
  const atBar = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => fixAt(at(from + i), bar.lat, bar.lng));

  it("fires as info after a 10+ min stay within 2 km during a date", () => {
    const fixes = [...insideFixes(0, 30), ...atBar(35, 46)];
    const out = evaluateTriggers(active(), at(46), fixes);
    expect(ids(out)).toEqual(["T-VENUE-CHG"]);
    expect(out[0]!.cls).toBe("info");
    expect(out[0]!.spot).toBeDefined();
  });

  it("does not fire while a New spot question is pending", () => {
    const fixes = [...insideFixes(0, 30), ...atBar(35, 46)];
    expect(evaluateTriggers(active({ pendingSpot: { ...bar, askedAt: at(45).toISOString() } }), at(46), fixes)).toEqual([]);
  });

  it("only for dates", () => {
    const fixes = [...insideFixes(0, 30), ...atBar(35, 46)];
    expect(ids(evaluateTriggers(active({ type: "viewing" }), at(46), fixes))).not.toContain("T-VENUE-CHG");
  });
});

describe("time-only mode and suppression", () => {
  it("no location triggers in time-only mode", () => {
    const fixes = [...insideFixes(0, 30), ...departFixes(30, 12, 3)];
    expect(evaluateTriggers(active({ locationMode: "none" }), at(33), fixes)).toEqual([]);
    expect(evaluateTriggers(active({ locationMode: "pin" }), at(60), [])).toEqual([]);
    expect(evaluateTriggers(active({ shareConfirmedAt: null }), at(60), [])).toEqual([]);
  });

  it("suppresses the same trigger for 20 min after an OK", () => {
    const p = active({ suppressedUntil: { "T-DARK": at(50).toISOString() } });
    expect(evaluateTriggers(p, at(45), insideFixes(0, 30))).toEqual([]);
    expect(ids(evaluateTriggers(p, at(50), insideFixes(0, 30)))).toEqual(["T-DARK"]);
  });

  it("sorts hard before soft before info", () => {
    expect(ids(sortTriggers([
      { id: "T-VENUE-CHG", cls: "info" },
      { id: "T-NOARRIVE", cls: "soft" },
      { id: "T-DARK", cls: "hard" },
    ]))).toEqual(["T-DARK", "T-NOARRIVE", "T-VENUE-CHG"]);
  });
});

describe("T-POST-EXIT status", () => {
  it("inside, left, unknown", () => {
    expect(postExitStatus(active(), at(40), insideFixes(30, 40))).toBe("inside");
    expect(postExitStatus(active(), at(40), [fixFromVenue(at(40), 600)])).toBe("left");
    expect(postExitStatus(active({ locationMode: "none" }), at(40), insideFixes(30, 40))).toBe("unknown");
    expect(postExitStatus(active(), at(40), [])).toBe("unknown");
  });
});
