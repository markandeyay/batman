// L5 (6.6 step 4, 7.3): after the exit word the user is expected to leave. Departure triggers
// are suppressed for 10 min and T-POST-EXIT decides; a departure that happened after the exit
// word never fires later either.
import { describe, expect, it } from "vitest";
import type { Fix } from "../../../apps/server/src/contracts.js";
import { applyEvent } from "../../../apps/server/src/plan/stateMachine.js";
import { evaluateTriggers } from "../../../apps/server/src/risk/triggers.js";
import { at, basePlan, ctxAt, fixFromVenue } from "../core/helpers.js";

// Inside the venue until minute 62, then away by car (about 8 m/s).
const fixes: Fix[] = [
  ...Array.from({ length: 8 }, (_, i) => fixFromVenue(at(55 + i), 10)),
  fixFromVenue(at(63), 500),
  fixFromVenue(at(64), 1000),
  fixFromVenue(at(65), 1500),
  fixFromVenue(at(66), 2000),
];
const active = (o = {}) => basePlan({ state: "ACTIVE", shareConfirmedAt: at(-20), arrivedAt: at(2), arrivalLineSent: true, transport: "walk", ...o });
const depIds = (now: Date, p = active({ exitWordAt: at(60) })) =>
  evaluateTriggers(p, now, fixes).map((t) => t.id).filter((id) => id.startsWith("T-DEP"));

describe("L5 departure after the exit word", () => {
  it("without an exit word the car departure fires (sanity)", () => {
    expect(depIds(at(66), active())).toContain("T-DEP-CAR");
  });

  it("within 10 min of the exit word no departure trigger fires", () => {
    expect(depIds(at(66))).toEqual([]);
  });

  it("T-POST-EXIT sees the user left; the earlier departure never fires afterwards", () => {
    const p = active({ exitWordAt: at(60) });
    const r = applyEvent(p, { type: "timer", job: "post_exit", payload: { exitAt: at(60).toISOString() } }, ctxAt(at(70), { fixes }));
    expect(r.plan.state).toBe("ACTIVE");
    expect(depIds(at(71), r.plan)).toEqual([]);
  });
});
