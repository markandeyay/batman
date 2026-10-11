// M7 (I14, I1): "done" before the meetup asks to cancel; a guardian who stops mid-plan is
// replaced; an escalation with no reachable guardian is logged at critical level.
// X3 (I10, I16): after a guardian STOP the ladder still reaches the user (L0 to L2); at L3 with
// no reachable guardian the user is told once, discreetly, and the plain explanation (911) waits
// until the window is over.
import { describe, expect, it } from "vitest";
import { DISCREET_STATES, type Effect, type EngineEvent } from "../../apps/server/src/contracts.js";
import { isDiscreet } from "../../apps/server/src/notify/discretion.js";
import { renderTemplate } from "../../apps/server/src/notify/templates.js";
import { PlanRuntime, type OutboundPort } from "../../apps/server/src/plan/runtime.js";
import { applyEvent } from "../../apps/server/src/plan/stateMachine.js";
import type { EngineContext, EnginePlan } from "../../apps/server/src/plan/types.js";
import { openStore } from "../../apps/server/src/store/db.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { FakeClock } from "../../apps/server/src/util/clock.js";
import { at, basePlan, ctxAt, T0 } from "../unit/core/helpers.js";
import { GUARDIAN, USER, makeHarness, seedPlan, seedUser } from "../unit/conversation/helpers.js";

type Send = Extract<Effect, { kind: "send" }>;
const sends = (fx: Effect[]) => fx.filter((e): e is Send => e.kind === "send");
const stoppedGuardian: Partial<EngineContext> = { guardian: { displayName: "Priya", linkStatus: "revoked", stopped: true } };

describe("M7 done before the meetup", () => {
  it.each(["ARMED", "PRE_MEETUP", "AWAITING_GUARDIAN"] as const)("%s: done asks to cancel; YES cancels, NO keeps it", async (state) => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, state);
    await h.text(USER, "done");
    expect(h.sentTo(USER).at(-1)?.template).toBe("plan_cancel_confirm_ask");
    expect(h.dispatched).toEqual([]);
    await h.text(USER, "yes");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "user_command", command: "cancel" } }]);

    const h2 = makeHarness();
    const s2 = await seedUser(h2);
    await seedPlan(h2, s2.user.id, s2.guardianId, state);
    await h2.text(USER, "done");
    await h2.text(USER, "no");
    expect(h2.dispatched).toEqual([]);
    expect(h2.sentTo(USER).at(-1)?.template).toBe("replace_kept");
  });

  it("ACTIVE: done is still passed straight to the engine", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ACTIVE");
    await h.text(USER, "done");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "user_command", command: "done" } }]);
  });
});

describe("M7 / X3 guardian lost mid-plan", () => {
  it("guardian STOP mid-plan: the user is told once (discreetly) and asked for a replacement", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ACTIVE");
    await h.text(GUARDIAN, "stop");
    expect(h.sentTo(USER).map((s) => s.template)).toEqual(["usr_guardian_stopped"]);
    expect((await h.repo.getDialogueState(user.id))?.pending).toEqual({ kind: "new_guardian" });
  });

  it("the engine's usr_guardian_stopped reads like a friend's text in a discreet state", () => {
    for (const state of DISCREET_STATES) {
      const r = applyEvent(basePlan({ state }), { type: "guardian_stop" }, ctxAt(at(30)));
      const s = sends(r.effects).find((e) => e.template === "usr_guardian_stopped")!;
      const text = renderTemplate(s.template, s.params ?? {}, { variant: 0 });
      expect(isDiscreet(text), text).toBe(true);
      expect(text).not.toMatch(/backup/i);
    }
  });

  it("after a guardian STOP the ladder still sends the user L0, L1, L2", () => {
    let p: EnginePlan = basePlan({ state: "ACTIVE", shareConfirmedAt: at(-20), endAt: at(120) });
    p = applyEvent(p, { type: "guardian_stop" }, ctxAt(at(100), stoppedGuardian)).plan;
    const ot = applyEvent(p, { type: "timer", job: "end_grace", payload: { endAt: at(120).toISOString() } }, ctxAt(at(135), stoppedGuardian));
    expect(sends(ot.effects).map((s) => s.template)).toEqual(["ot_overtime"]);
    const l1 = applyEvent(ot.plan, { type: "timer", job: "overtime_timeout", payload: { token: ot.plan.ladderStartedAt!.toISOString() } }, ctxAt(at(145), stoppedGuardian));
    expect(sends(l1.effects).map((s) => s.template)).toEqual(["lad_l1"]);
    const l2 = applyEvent(l1.plan, { type: "timer", job: "ladder", payload: { step: "L2", token: l1.plan.ladderStartedAt!.toISOString() } }, ctxAt(at(150), stoppedGuardian));
    expect(sends(l2.effects).map((s) => s.template)).toEqual(["lad_l2_text"]);
  });

  it("L3 with no reachable guardian: one discreet line to the user; explanation only after the window", () => {
    const p = basePlan({ state: "CHECKING", shareConfirmedAt: at(-20), ladderStep: "L2", ladderClass: "overtime", ladderTrigger: "T-OVR", ladderStartedAt: at(135), ladderStepAt: at(150) });
    const l3: EngineEvent = { type: "timer", job: "ladder", payload: { step: "L3", token: at(135).toISOString() } };
    const r = applyEvent(p, l3, ctxAt(at(153), stoppedGuardian));
    expect(r.plan.state).toBe("ESCALATED");
    const userLines = sends(r.effects).filter((s) => s.to === "user");
    expect(userLines.map((s) => s.template)).toEqual(["usr_backup_unreachable"]);
    const text = renderTemplate(userLines[0]!.template, userLines[0]!.params ?? {}, { variant: 0 });
    expect(text).toBe("Couldn't get hold of Priya. Text me when you can.");
    expect(isDiscreet(text)).toBe(true);
    expect(r.effects.some((e) => e.kind === "audit" && e.event === "escalation_no_guardian")).toBe(true);
    // Once: a later stronger reason does not repeat it.
    const again = applyEvent(r.plan, { type: "alert_word", messageId: "m" }, ctxAt(at(154), stoppedGuardian));
    expect(sends(again.effects).filter((s) => s.template === "usr_backup_unreachable")).toEqual([]);
    // The plain explanation goes out when the plan closes, outside the window.
    const closed = applyEvent(r.plan, { type: "user_command", command: "home" }, ctxAt(at(160), stoppedGuardian));
    expect(sends(closed.effects).map((s) => s.template)).toContain("usr_backup_unreachable_explain");
  });

  it("the runtime logs an escalation with no reachable guardian at critical level", async () => {
    const store = openStore(":memory:");
    repo.createUser(store, { addressE164: USER, displayName: "Alex", now: T0, id: "user-1" });
    const g = repo.upsertGuardian(store, { addressE164: GUARDIAN, displayName: "Priya", now: T0 });
    repo.setGuardianLink(store, { userId: "user-1", guardianId: g.id, status: "revoked", now: T0 });
    const plan = repo.insertPlan(store, basePlan({ guardianId: g.id, state: "ACTIVE" }));
    const critical: string[] = [];
    const port: OutboundPort = { send: async () => null, react: async () => {}, call: async () => false, requestLocation: async () => {}, startWatch: async () => {}, stopWatch: async () => {} };
    const rt = new PlanRuntime({ store, clock: new FakeClock(at(30)), jobs: { enqueue: () => 0, cancel: () => 0 }, out: port, defaultTz: "America/New_York", onCritical: (event) => critical.push(event) });
    await rt.dispatch(plan.id, { type: "distress", messageId: "m" });
    await rt.idle();
    expect(critical).toContain("escalation_no_guardian");
  });
});
