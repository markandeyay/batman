// X2: contract gaps the full-stack harness had to glue over, now closed in production code.
//  - The runtime finds the user's latest inbound message id itself (tapback target, 4.5 step 3).
//  - Jobs without a plan (guardian opt-in expiry, 4.3) have a handler hook on the runtime.
//  - The engine knows about address-level STOP (I14): no sends to a stopped user or guardian.
import { describe, expect, it } from "vitest";
import type { E164, Effect } from "../../apps/server/src/contracts.js";
import { PlanRuntime, type OutboundPort } from "../../apps/server/src/plan/runtime.js";
import type { JobRecord } from "../../apps/server/src/scheduler/jobs.js";
import { openStore, type Store } from "../../apps/server/src/store/db.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { FakeClock } from "../../apps/server/src/util/clock.js";
import { at, basePlan, T0 } from "../unit/core/helpers.js";

const USER = "+13125550100" as E164;
const GUARDIAN = "+19195550142" as E164;

function setup(state: Parameters<typeof basePlan>[0] = {}) {
  const store = openStore(":memory:");
  repo.createUser(store, { addressE164: USER, displayName: "Alex", now: T0, id: "user-1" });
  const g = repo.upsertGuardian(store, { addressE164: GUARDIAN, displayName: "Priya", now: T0 });
  repo.setGuardianLink(store, { userId: "user-1", guardianId: g.id, status: "accepted", now: T0 });
  const plan = repo.insertPlan(store, basePlan({ guardianId: g.id, ...state }));
  const log: string[] = [];
  const port: OutboundPort = {
    send: async (e) => (log.push(`send:${e.to}:${e.template}`), { id: `o${log.length}`, at: T0 }),
    react: async (e) => void log.push(`react:${e.messageId}`),
    call: async (e) => (log.push(`call:${e.to}:${e.script}`), true),
    requestLocation: async () => void log.push("request_location"),
    startWatch: async () => {},
    stopWatch: async () => {},
  };
  const rt = (o: Partial<ConstructorParameters<typeof PlanRuntime>[0]> = {}) =>
    new PlanRuntime({ store, clock: new FakeClock(at(-29)), jobs: { enqueue: () => 0, cancel: () => 0 }, out: port, defaultTz: "America/New_York", ...o });
  return { store, plan, log, rt };
}

const inbound = (store: Store, id: string, at_: Date) =>
  repo.recordMessage(store, { platformMessageId: id, direction: "inbound", addressE164: USER, kind: "text", bodyRedacted: "x", sentAt: at_ });

describe("X2 contract gaps closed", () => {
  it("share accepted by a loc_poll job: the tapback targets the user's latest inbound message from the store", async () => {
    const s = setup({ state: "PRE_MEETUP", locRequestedAt: at(-30) });
    inbound(s.store, "in-old", at(-40));
    inbound(s.store, "in-latest", at(-35));
    const rt = s.rt({ shareProbe: async () => ({ visible: true, expiresAt: null }) });
    const job: JobRecord = { id: 1, kind: "loc_poll", planId: s.plan.id, runAt: at(-29), payload: undefined, status: "running", attempts: 1, lastError: null, createdAt: at(-30) };
    await rt.handleJob(job);
    expect(s.log).toContain("react:in-latest");
  });

  it("jobs without a plan go to the planless handler (guardian opt-in expiry)", async () => {
    const s = setup();
    const rt = s.rt();
    const got: string[] = [];
    rt.setPlanlessJobHandler(async (job) => void got.push(job.kind));
    await rt.handleJob({ id: 2, kind: "optin_expire", planId: null, runAt: T0, payload: { userId: "user-1", guardianId: "g" }, status: "running", attempts: 1, lastError: null, createdAt: T0 });
    expect(got).toEqual(["optin_expire"]);
  });

  it("the engine sends nothing to a user or guardian address that said STOP (I14)", async () => {
    const s = setup({ state: "ACTIVE", shareConfirmedAt: at(-20) });
    repo.setStopped(s.store, GUARDIAN, T0);
    const rt = s.rt();
    await rt.dispatch(s.plan.id, { type: "alert_word", messageId: "m" });
    await rt.idle();
    expect(s.log.filter((l) => l.includes(":guardian:"))).toEqual([]);
    const s2 = setup({ state: "ACTIVE", shareConfirmedAt: at(-20) });
    repo.setStopped(s2.store, USER, T0);
    const rt2 = s2.rt();
    const out = await rt2.dispatch(s2.plan.id, { type: "user_command", command: "extend", minutes: 30 });
    expect(s2.log.filter((l) => l.startsWith("send:user"))).toEqual([]);
    expect((out?.effects ?? []).some((e: Effect) => e.kind === "audit" && e.event === "user_send_skipped_stopped")).toBe(true);
  });
});
