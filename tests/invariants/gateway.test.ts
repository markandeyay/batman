// Gateway-level invariant tests (spec Section 3): I2, I3, I4, I6, I12.
import { describe, expect, it } from "vitest";
import type { E164, Fix, LocationSource, TemplateParams } from "../../apps/server/src/contracts.js";
import { EmergencyNumberError } from "../../apps/server/src/gateway/errors.js";
import { FindMyLocationSource, type LocationsApi } from "../../apps/server/src/location/findmy.js";
import { PlanRuntime } from "../../apps/server/src/plan/runtime.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { FakeClock, GUARDIAN, T0, USER, makeExecutor, seededStore } from "../unit/integration/gatewayHelpers.js";

const fix = (lat = 41.917234, lng = -87.706789): Fix => ({ lat, lng, accuracyM: 10, at: T0, locationType: "shallow", expiresAt: null, source: "findmy" });
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("I2 only watch the initiator", () => {
  it("FindMy forwards only the user's exact address and never touches list()", async () => {
    const calls: string[] = [];
    const other = "+19195550142";
    const api = new Proxy({} as LocationsApi, {
      get: (_t, prop: string) => {
        if (prop === "list") throw new Error("list() must never be called (I2)");
        if (prop === "watch")
          return (a: string) => {
            calls.push(`watch:${a}`);
            return {
              close() {},
              async *[Symbol.asyncIterator]() {
                yield { location: { address: other, latitude: 1, longitude: 2, locationType: "live" }, sourceSequence: 1 };
                yield { location: { address: `${USER} `, latitude: 1, longitude: 2, locationType: "live" }, sourceSequence: 2 };
                yield { location: { address: USER, latitude: 41.9, longitude: -87.7, locationType: "live" }, sourceSequence: 3 };
              },
            };
          };
        if (prop === "get") return async (a: string) => (calls.push(`get:${a}`), { address: other, latitude: 5, longitude: 5, locationType: "live" });
        return undefined;
      },
    });
    const clock = new FakeClock(T0);
    const got: Fix[] = [];
    const src = new FindMyLocationSource({ api, clock });
    await src.start(USER, (f) => got.push(f));
    await flush();
    await clock.advance(60_000);
    await flush();
    await src.stop();
    expect(got.map((f) => f.lat)).toEqual([41.9]);
    expect(calls.every((c) => c.endsWith(USER))).toBe(true);
  });

  it("request_location and start_watch target only the plan's own user", async () => {
    const { store, plan } = seededStore("PRE_MEETUP");
    const targets: string[] = [];
    const t = makeExecutor(store, new FakeClock(T0), {
      locations: { request: async (_c: string, a: string) => (targets.push(a), { status: "sent" }) },
      createLocationSource: (_p, a) => (targets.push(a), { start: async () => {}, stop: async () => {} }),
    });
    await t.executor.requestLocation(plan);
    await t.executor.startWatch(plan);
    expect(targets).toEqual([USER, USER]);
    expect(targets).not.toContain(GUARDIAN);
  });
});

describe("I3 time-boxed", () => {
  it("fixes are stored only while the plan is in a window, and none arrive after stop_watch", async () => {
    const { store, plan } = seededStore("ACTIVE");
    const clock = new FakeClock(T0);
    let emit: ((f: Fix, from: E164) => void) | null = null;
    const src: LocationSource = { start: async (_a, cb) => void (emit = cb), stop: async () => {} };
    const t = makeExecutor(store, clock, { createLocationSource: () => src });
    const runtime = new PlanRuntime({ store, clock, jobs: { enqueue: () => 0, cancel: () => 0 }, out: t.executor, defaultTz: "America/New_York" });
    t.executor.bind({ ingestFix: (id, f) => runtime.ingestFix(id, f), dispatch: (id, e) => runtime.dispatch(id, e) });
    await t.executor.startWatch(plan);
    emit!(fix(), USER);
    await flush();
    await new Promise((r) => setTimeout(r, 5));
    expect(repo.listFixes(store, plan.id)).toHaveLength(1);
    await t.executor.stopWatch(plan);
    emit!(fix(41.95), USER);
    await new Promise((r) => setTimeout(r, 5));
    expect(repo.listFixes(store, plan.id)).toHaveLength(1);
    repo.savePlan(store, { ...repo.getPlan(store, plan.id)!, state: "CLOSED" });
    expect(await runtime.ingestFix(plan.id, fix(41.96))).toBe(false);
    expect(repo.listFixes(store, plan.id)).toHaveLength(1);
  });
});

describe("I4 minimal disclosure", () => {
  it("location params reach only the guardian of an ESCALATED plan", async () => {
    for (const state of ["ACTIVE", "CHECKING", "ESCALATED"] as const) {
      const { store, plan } = seededStore(state);
      const t = makeExecutor(store, new FakeClock(T0));
      await t.executor.send({ kind: "send", to: "guardian", template: "gdn_location_update", params: { fix: fix() } }, plan);
      await t.executor.send({ kind: "send", to: "user", template: "act_mid_check", params: { fix: fix(), lastFix: fix() } as unknown as TemplateParams }, plan);
      const g = t.resolver.space(GUARDIAN).sent[0]!;
      const u = t.resolver.space(USER).sent[0]!;
      expect(u).not.toMatch(/41\.9/);
      if (state === "ESCALATED") expect(g).toMatch(/41\.917234/);
      else expect(g).not.toMatch(/41\.9/);
    }
  });
});

describe("I6 never contact emergency services", () => {
  it("no text and no call to an emergency number, even if one is stored as a guardian", async () => {
    const { store, plan } = seededStore("ESCALATED");
    const g = repo.upsertGuardian(store, { addressE164: "+1911" as E164, displayName: "bad", now: T0 });
    const p = { ...plan, guardianId: g.id };
    const t = makeExecutor(store, new FakeClock(T0), { speech: true });
    expect(await t.executor.send({ kind: "send", to: "guardian", template: "gdn_alert", critical: true }, p)).toBeNull();
    expect(await t.executor.call({ kind: "call", to: "guardian", script: "guardian_alert" }, p)).toBe(false);
    await t.executor.idle();
    expect(t.placed).toEqual([]);
    for (const n of ["911", "+1911", "112", "999"]) await expect(t.channel.sendText(n as E164, "hi")).rejects.toBeInstanceOf(EmergencyNumberError);
    expect(t.resolver.spaces.size).toBe(0);
  });
});

describe("I12 deletion", () => {
  it("stored outbound bodies never hold coordinates; purge removes raw fixes", async () => {
    const { store, plan } = seededStore("ESCALATED");
    const t = makeExecutor(store, new FakeClock(T0));
    await t.executor.send({ kind: "send", to: "guardian", template: "gdn_location_update", params: { fix: fix() } }, plan);
    expect(t.resolver.space(GUARDIAN).sent[0]).toMatch(/41\.917234/); // the guardian got it during the escalation
    const bodies = store.sqlite.prepare("SELECT body_redacted FROM messages").all() as { body_redacted: string }[];
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b.body_redacted).not.toMatch(/41\.917/);
    repo.insertFix(store, plan.id, fix(), T0);
    t.executor.purgeLocation(plan.id);
    expect(repo.listFixes(store, plan.id)).toEqual([]);
  });
});
