// L2 (I2): a fix must come with the address it belongs to. guardedFixHandler rejects a missing
// address, and LocationSource.onFix carries the address so the executor checks it (X2).
import { describe, expect, it } from "vitest";
import type { E164, Fix, LocationSource } from "../../../apps/server/src/contracts.js";
import { guardedFixHandler } from "../../../apps/server/src/location/source.js";
import { FakeClock, T0, USER, makeExecutor, seededStore } from "../integration/gatewayHelpers.js";

const fix: Fix = { lat: 41.9, lng: -87.7, accuracyM: 10, at: T0, locationType: "live", expiresAt: null, source: "findmy" };

describe("L2 fixes need an address", () => {
  it("guardedFixHandler rejects a missing or null address", () => {
    const got: Fix[] = [];
    const h = guardedFixHandler(USER, () => "ACTIVE", (f) => got.push(f));
    expect(h(fix, undefined as unknown as string)).toBe(false);
    expect(h(fix, null)).toBe(false);
    expect(h(fix, "+13125550199")).toBe(false);
    expect(h(fix, USER)).toBe(true);
    expect(got).toHaveLength(1);
  });

  it("the executor ingests only fixes whose address is the plan's user", async () => {
    const { store, plan } = seededStore("ACTIVE");
    let emit: ((f: Fix, from: E164) => void) | null = null;
    const src: LocationSource = { start: async (_a, onFix) => void (emit = onFix), stop: async () => {} };
    const t = makeExecutor(store, new FakeClock(T0), { createLocationSource: () => src });
    const ingested: string[] = [];
    t.executor.bind({ ingestFix: async (id) => void ingested.push(id), dispatch: async () => {} });
    await t.executor.startWatch(plan);
    emit!(fix, "+13125550199" as E164);
    emit!(fix, USER);
    expect(ingested).toEqual([plan.id]);
  });
});
