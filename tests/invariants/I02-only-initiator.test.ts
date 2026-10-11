// I2. Only watch the initiator: Batman never requests, reads, or stores the location of anyone
// except the user who created the active plan; list() results are filtered by exact address.
import { afterEach, describe, expect, it } from "vitest";
import type { Fix } from "../../apps/server/src/contracts.js";
import { belongsToUser, filterByExactAddress, guardedFixHandler } from "../../apps/server/src/location/source.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { DATE_EXTRACTION, FullStack, GUARDIAN, STRANGER, USER } from "../sim/fullstack.js";

const sims: FullStack[] = [];
afterEach(() => sims.splice(0).forEach((s) => s.close()));

const fix = (lat: number): Fix => ({ lat, lng: -87.7, accuracyM: 10, at: new Date("2026-10-10T23:30:00Z"), locationType: "live", expiresAt: null, source: "findmy" });

describe("I2 only the initiator", () => {
  it("list() filtering keeps exact address matches only (no prefix, no formatting variants)", () => {
    const entries = [
      { address: USER, fix: fix(1) },
      { address: STRANGER, fix: fix(2) },
      { address: GUARDIAN, fix: fix(3) },
      { address: USER.slice(1), fix: fix(4) }, // missing "+"
      { address: `${USER} `, fix: fix(5) },
      { address: null, fix: fix(6) },
      { fix: fix(7) },
    ];
    expect(filterByExactAddress(entries, USER).map((e) => e.fix.lat)).toEqual([1]);
    expect(belongsToUser(undefined, USER)).toBe(false);
  });

  it("the fix guard rejects any other sender even in a window", () => {
    const got: Fix[] = [];
    const h = guardedFixHandler(USER, () => "ACTIVE", (f) => got.push(f));
    expect(h(fix(1), STRANGER)).toBe(false);
    expect(h(fix(2), GUARDIAN)).toBe(false);
    expect(h(fix(3), USER)).toBe(true);
    expect(got.map((f) => f.lat)).toEqual([3]);
  });

  it("full stack: the watcher is started for the plan user only, and other people's fixes are never stored", async () => {
    const s = new FullStack({ track: "date-normal", trackMessages: false, llm: { extract: [{ match: "jordan", out: DATE_EXTRACTION }] } });
    sims.push(s);
    await s.onboard();
    await s.planDate();
    await s.runUntil(30);
    expect(s.location.address).toBe(USER);
    const planId = s.plan()!.id;
    const n = repo.listFixes(s.store, planId).length;
    for (const who of [STRANGER, GUARDIAN]) expect(s.location.handler!({ ...fix(45), at: s.clock.now() }, who)).toBe(false);
    await s.runUntil(30.5);
    expect(repo.listFixes(s.store, planId).length).toBe(n);
    expect(repo.listFixes(s.store, planId).some((f) => f.lat === 45)).toBe(false);
  });
});
