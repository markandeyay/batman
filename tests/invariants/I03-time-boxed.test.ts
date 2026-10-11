// I3. Time-boxed: location is only processed while a plan is in a window. Fixes received
// outside a window are discarded, not stored.
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_STATES, WINDOW_STATES, type Fix } from "../../apps/server/src/contracts.js";
import { acceptsFixInState, guardedFixHandler } from "../../apps/server/src/location/source.js";
import { acceptsFixes } from "../../apps/server/src/plan/stateMachine.js";
import { Sim, USER } from "../sim/harness.js";

const sims: Sim[] = [];
afterEach(() => sims.splice(0).forEach((s) => s.close()));

describe("I3 time-boxed", () => {
  it.each(PLAN_STATES.map((s) => [s]))("%s: fixes accepted only in window states", (state) => {
    const inWindow = WINDOW_STATES.includes(state);
    expect(acceptsFixes(state)).toBe(inWindow);
    expect(acceptsFixInState(state)).toBe(inWindow);
    const got: Fix[] = [];
    const h = guardedFixHandler(USER, () => state, (f) => got.push(f));
    h({ lat: 1, lng: 2, accuracyM: 5, at: new Date(), locationType: "live", expiresAt: null, source: "findmy" }, USER);
    expect(got.length).toBe(inWindow ? 1 : 0);
  });

  it("the runtime discards fixes before the window and after close (nothing stored)", async () => {
    const s = await Sim.create({ track: "date-normal", plan: { firstTimeInPerson: false } });
    sims.push(s);
    const f = (): Fix => ({ lat: 41.9, lng: -87.7, accuracyM: 10, at: s.clock.now(), locationType: "live", expiresAt: null, source: "findmy" });
    expect(s.plan().state).toBe("ARMED");
    expect(await s.runtime.ingestFix(s.planId, f())).toBe(false);
    expect(s.storedFixes()).toEqual([]);
    await s.runUntil(140);
    expect(s.plan().state).toBe("CLOSED");
    const n = s.storedFixes().length;
    expect(n).toBeGreaterThan(0);
    expect(await s.runtime.ingestFix(s.planId, f())).toBe(false);
    expect(s.storedFixes().length).toBe(n);
    // The watcher stopped when the plan closed, so no further fixes are even delivered.
    expect(s.out.filter((o) => o.kind === "stop_watch").map((o) => o.t)).toEqual([130]);
  });
});
