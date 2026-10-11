// M3 (I16): a persistently failing handler sends plain_checkin_error at most once per plan per
// hour, and if an L3, alert word, or distress handler throws, a minimal fixed guardian alert
// still goes out (once) through a fallback path.
import { describe, expect, it } from "vitest";
import type { EngineEvent, GuardianLinkStatus } from "../../apps/server/src/contracts.js";
import { renderTemplate } from "../../apps/server/src/notify/templates.js";
import { PlanRuntime, type OutboundPort, type SendEffect } from "../../apps/server/src/plan/runtime.js";
import { applyEvent } from "../../apps/server/src/plan/stateMachine.js";
import { openStore } from "../../apps/server/src/store/db.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { FakeClock } from "../../apps/server/src/util/clock.js";
import { at, basePlan, MIN, T0 } from "../unit/core/helpers.js";

const USER = "+13125550100";
const GUARDIAN = "+19195550142";

function setup(opts: { throwOn: (e: EngineEvent) => boolean; link?: GuardianLinkStatus }) {
  const store = openStore(":memory:");
  repo.createUser(store, { addressE164: USER, displayName: "Alex", now: T0, id: "user-1" });
  const g = repo.upsertGuardian(store, { addressE164: GUARDIAN, displayName: "Priya", now: T0 });
  repo.setGuardianLink(store, { userId: "user-1", guardianId: g.id, status: opts.link ?? "accepted", now: T0 });
  const plan = repo.insertPlan(store, basePlan({ guardianId: g.id, state: "CHECKING", shareConfirmedAt: at(-20), ladderStep: "L2", ladderClass: "soft", ladderTrigger: "T-DEP-WALK", ladderStartedAt: at(30), ladderStepAt: at(35) }));
  const sent: SendEffect[] = [];
  const critical: string[] = [];
  const port: OutboundPort = {
    send: async (e) => (sent.push(e), { id: `o${sent.length}`, at: T0 }),
    react: async () => {},
    call: async () => true,
    requestLocation: async () => {},
    startWatch: async () => {},
    stopWatch: async () => {},
  };
  const clock = new FakeClock(at(40));
  const rt = new PlanRuntime({
    store,
    clock,
    jobs: { enqueue: () => 0, cancel: () => 0 },
    out: port,
    defaultTz: "America/New_York",
    engine: (p, e, c) => {
      if (opts.throwOn(e)) throw new Error("boom");
      return applyEvent(p, e, c);
    },
    onCritical: (ev) => critical.push(ev),
  });
  return { rt, sent, critical, plan, clock };
}

const run = async (rt: PlanRuntime, planId: string, e: EngineEvent) => {
  await rt.dispatch(planId, e).catch(() => undefined); // the runtime rethrows so the scheduler retries
};

describe("M3 fail toward the user, and still alert the guardian", () => {
  it("plain_checkin_error at most once per hour across retries", async () => {
    const s = setup({ throwOn: (e) => e.type === "fix" });
    const fix = { type: "fix" as const, fix: { lat: 1, lng: 2, accuracyM: 10, at: at(40), locationType: "live" as const, expiresAt: null, source: "findmy" as const } };
    for (let i = 0; i < 5; i++) await run(s.rt, s.plan.id, fix);
    expect(s.sent.filter((e) => e.template === "plain_checkin_error")).toHaveLength(1);
    await s.clock.advance(61 * MIN);
    await run(s.rt, s.plan.id, fix);
    expect(s.sent.filter((e) => e.template === "plain_checkin_error")).toHaveLength(2);
    expect(s.sent.some((e) => e.to === "guardian")).toBe(false); // not a safety-critical event
  });

  it.each<[string, EngineEvent]>([
    ["L3 ladder step", { type: "timer", job: "ladder", payload: { step: "L3", token: at(30).toISOString() } }],
    ["alert word", { type: "alert_word", messageId: "m" }],
    ["distress", { type: "distress", messageId: "m" }],
  ])("%s handler throws: one minimal fixed guardian alert via the fallback path", async (_n, ev) => {
    const s = setup({ throwOn: (e) => e.type !== "internal_error" });
    for (let i = 0; i < 5; i++) await run(s.rt, s.plan.id, ev);
    const g = s.sent.filter((e) => e.to === "guardian");
    expect(g.map((e) => [e.template, e.critical, e.notifyAnyway])).toEqual([["gdn_alert", true, true]]);
    const text = renderTemplate(g[0]!.template, g[0]!.params ?? {}, { variant: 0 });
    expect(text).toMatch(/^⚠️ Alex might need help\./);
    expect(text).toContain("If you think they're in danger, call 911.");
    expect(s.critical).toContain("fallback_guardian_alert");
  });

  it("no accepted guardian: no fallback send, logged critical", async () => {
    const s = setup({ throwOn: (e) => e.type !== "internal_error", link: "revoked" });
    await run(s.rt, s.plan.id, { type: "alert_word", messageId: "m" });
    expect(s.sent.some((e) => e.to === "guardian")).toBe(false);
    expect(s.critical).toContain("fallback_guardian_alert_unreachable");
  });
});
