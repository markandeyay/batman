// H3 (I8, I5, I16): code words are checked for every onboarded user in every state, never reach
// the model, and the alert word and distress escalate before T-30 (ARMED, AWAITING_GUARDIAN) when
// a guardian has accepted. With no accepted guardian: an innocuous reply for code words and the
// no_plan_distress copy for distress.
import { describe, expect, it } from "vitest";
import type { Effect } from "../../apps/server/src/contracts.js";
import { FakeLlmProvider } from "../../apps/server/src/nlu/llm.js";
import { applyEvent } from "../../apps/server/src/plan/stateMachine.js";
import { at, basePlan, ctxAt } from "../unit/core/helpers.js";
import { USER, makeHarness, seedPlan, seedUser } from "../unit/conversation/helpers.js";

const countingLlm = () => new FakeLlmProvider(() => ({}));
const kinds = (fx: Effect[]) =>
  fx.flatMap((e) => (e.kind === "send" ? [`send:${e.to}:${e.template}`] : e.kind === "call" ? [`call:${e.to}:${e.script}`] : []));

describe("H3 dialogue: code words before the window", () => {
  it.each(["ARMED", "AWAITING_GUARDIAN", "PRE_MEETUP"] as const)("%s: alert word is dispatched, the model is never called", async (state) => {
    const llm = countingLlm();
    const h = makeHarness({ llm });
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, state);
    expect(await h.text(USER, "ugh blue moon")).toBe("codeword_alert");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "alert_word", messageId: expect.any(String) } }]);
    expect(llm.calls).toEqual([]);
  });

  it("ARMED: exit word is dispatched", async () => {
    const h = makeHarness({ llm: countingLlm() });
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ARMED");
    await h.text(USER, "pineapple");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "exit_word", messageId: expect.any(String) } }]);
  });

  it.each([["no plan"], ["DRAFT"]] as const)("%s: code word gets only an innocuous reply and never reaches the model", async (which) => {
    const llm = countingLlm();
    const h = makeHarness({ llm });
    const { user, guardianId } = await seedUser(h);
    if (which === "DRAFT") await seedPlan(h, user.id, guardianId, "DRAFT");
    await h.text(USER, "blue moon");
    await h.text(USER, "pineapple");
    expect(h.dispatched).toEqual([]);
    expect(llm.calls).toEqual([]);
    expect(h.sentTo(USER).map((s) => s.template)).toEqual(["cw_alert_reply", "cw_exit_reply"]);
  });

  it("ARMED: explicit distress is dispatched; with no plan it gets no_plan_distress", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ARMED");
    await h.text(USER, "he won't let me leave");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "distress", messageId: expect.any(String) } }]);
    const h2 = makeHarness();
    await seedUser(h2);
    await h2.text(USER, "he won't let me leave");
    expect(h2.sentTo(USER).map((s) => s.template)).toEqual(["no_plan_distress"]);
  });

  it("a user re-entering code words outside a window does not trigger the old ones", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ARMED");
    await h.text(USER, "change code words");
    h.clear();
    await h.text(USER, "exit mango tango, alert blue moon");
    expect(h.dispatched).toEqual([]);
  });
});

describe("H3 engine: alert word and distress before T-30", () => {
  const armed = basePlan({ state: "ARMED", startAt: at(120), endAt: at(240) });
  const noGuardian = { guardian: { displayName: "Priya", linkStatus: "pending" as const, stopped: false } };

  it("ARMED + alert word with an accepted guardian: escalates, guardian alerted, innocuous reply only", () => {
    const r = applyEvent(armed, { type: "alert_word", messageId: "m" }, ctxAt(at(0)));
    expect(r.plan.state).toBe("ESCALATED");
    expect(r.plan.preEscalationState).toBe("ARMED");
    expect(kinds(r.effects)).toEqual(["send:user:cw_alert_reply", "send:guardian:gdn_alert", "call:guardian:guardian_alert"]);
    const cancelled = r.effects.filter((e) => e.kind === "cancel_jobs").flatMap((e) => (e.kind === "cancel_jobs" ? (e.kinds ?? []) : []));
    expect(cancelled).toEqual(expect.arrayContaining(["t_minus_30", "start"]));
  });

  it("AWAITING_GUARDIAN + alert word with no accepted guardian: innocuous reply only", () => {
    const p = { ...armed, state: "AWAITING_GUARDIAN" as const };
    const r = applyEvent(p, { type: "alert_word", messageId: "m" }, ctxAt(at(0), noGuardian));
    expect(r.plan.state).toBe("AWAITING_GUARDIAN");
    expect(kinds(r.effects)).toEqual(["send:user:cw_alert_reply"]);
  });

  it("ARMED + distress with an accepted guardian: Calling you now, exit call, guardian alert", () => {
    const r = applyEvent(armed, { type: "distress", messageId: "m" }, ctxAt(at(0)));
    expect(r.plan.state).toBe("ESCALATED");
    expect(kinds(r.effects)).toEqual(["send:user:act_calling_you_now", "call:user:fake", "send:guardian:gdn_alert", "call:guardian:guardian_alert"]);
  });

  it("ARMED + distress with no accepted guardian: no_plan_distress", () => {
    const r = applyEvent(armed, { type: "distress", messageId: "m" }, ctxAt(at(0), noGuardian));
    expect(r.plan.state).toBe("ARMED");
    expect(kinds(r.effects)).toEqual(["send:user:no_plan_distress"]);
  });

  it("ARMED + exit word: innocuous reply and the fake call", () => {
    const r = applyEvent(armed, { type: "exit_word", messageId: "m" }, ctxAt(at(0)));
    expect(r.plan.state).toBe("ARMED");
    expect(kinds(r.effects)).toEqual(["send:user:cw_exit_reply", "call:user:fake"]);
  });

  it("de-escalating an ARMED-origin escalation before the start re-arms the plan", () => {
    const esc = applyEvent(armed, { type: "alert_word", messageId: "m" }, ctxAt(at(0))).plan;
    const r = applyEvent(esc, { type: "user_reply", label: "OK", messageId: "m2", okNow: true }, ctxAt(at(10)));
    expect(r.plan.state).toBe("ARMED");
    const jobs = r.effects.flatMap((e) => (e.kind === "schedule" ? [e.job.kind] : []));
    expect(jobs).toEqual(expect.arrayContaining(["t_minus_30", "start"]));
    expect(jobs).not.toContain("end_grace");
  });
});
