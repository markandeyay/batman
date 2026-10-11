// C2 (I7, 6.7 step 4): during an alert-word or distress escalation only a deterministic "home",
// "I'm okay now", "done", or "cancel" de-escalates. A classifier OK, a tapback, or "+30" never do.
// H1 (I7): the model may not produce done, home, or cancel; model "moving" is re-confirmed.
import { describe, expect, it } from "vitest";
import type { Effect, EngineEvent } from "../../apps/server/src/contracts.js";
import { classifyReply } from "../../apps/server/src/nlu/classifyReply.js";
import { FakeLlmProvider } from "../../apps/server/src/nlu/llm.js";
import { isOkNow } from "../../apps/server/src/nlu/rules.js";
import { applyEvent } from "../../apps/server/src/plan/stateMachine.js";
import type { EnginePlan } from "../../apps/server/src/plan/types.js";
import { at, basePlan, ctxAt } from "../unit/core/helpers.js";
import { USER, makeHarness, seedPlan, seedUser } from "../unit/conversation/helpers.js";

const esc = (kind: "alert_word" | "distress" | "no_reply"): EnginePlan =>
  basePlan({
    state: "ESCALATED",
    shareConfirmedAt: at(-20),
    escalatedAt: at(40),
    escalationReason: kind === "no_reply" ? { kind, trigger: "T-OVR", minutesSilent: 10 } : { kind },
    ladderStep: "L3",
    lastCheckinMessageId: "out-9",
  });
const guardianSends = (fx: Effect[]) => fx.filter((e) => e.kind === "send" && e.to === "guardian");
const userSends = (fx: Effect[]) => fx.filter((e) => e.kind === "send" && e.to === "user");

describe("C2 silent escalations only end on deterministic replies", () => {
  for (const kind of ["alert_word", "distress"] as const) {
    describe(kind, () => {
      const notDeescalating: Array<[string, EngineEvent]> = [
        ["classifier OK", { type: "user_reply", label: "OK", messageId: "m1" }],
        ["tapback on the last check-in", { type: "user_reaction", emoji: "like", targetMessageId: "out-9" }],
        ["+30", { type: "user_command", command: "extend", minutes: 30 }],
        ["AMBIGUOUS", { type: "user_reply", label: "AMBIGUOUS", messageId: "m1" }],
      ];
      it.each(notDeescalating)("%s keeps the plan ESCALATED and tells the guardian nothing", (_n, ev) => {
        const r = applyEvent(esc(kind), ev, ctxAt(at(45)));
        expect(r.plan.state).toBe("ESCALATED");
        expect(guardianSends(r.effects)).toEqual([]);
        expect(r.effects.some((e) => e.kind === "cancel_jobs" && (!e.kinds || e.kinds.includes("guardian_repeat")))).toBe(false);
      });

      it("deterministic 'I'm okay now' de-escalates and tells the guardian", () => {
        const r = applyEvent(esc(kind), { type: "user_reply", label: "OK", messageId: "m1", okNow: true }, ctxAt(at(45)));
        expect(r.plan.state).toBe("ACTIVE");
        expect(guardianSends(r.effects).map((e) => (e as { template: string }).template)).toEqual(["gdn_user_ok_now"]);
        // 6.7 step 3: nothing about the alert goes to the user.
        expect(userSends(r.effects)).toEqual([]);
      });

      it.each(["home", "done", "cancel"] as const)("%s ends the escalation", (command) => {
        const r = applyEvent(esc(kind), { type: "user_command", command }, ctxAt(at(45)));
        expect(r.plan.state).not.toBe("ESCALATED");
      });
    });
  }

  it("a no-reply escalation still resolves on a classifier OK (spec 5.3)", () => {
    const r = applyEvent(esc("no_reply"), { type: "user_reply", label: "OK", messageId: "m1" }, ctxAt(at(45)));
    expect(r.plan.state).toBe("ACTIVE");
  });

  it("isOkNow matches only explicit 'okay now' variants", () => {
    for (const t of ["I'm okay now", "im ok now", "i am okay now", "I'm OK now!", "im alright now", "i'm fine now thanks"]) expect(isOkNow(t), t).toBe(true);
    for (const t of ["ok", "yeah all good", "im okay", "lol fine", "not okay now", "im not ok now", "are you okay now"]) expect(isOkNow(t), t).toBe(false);
  });

  it("dialogue passes okNow only for the deterministic phrase", async () => {
    const llm = new FakeLlmProvider(() => ({ label: "OK", command: null, extendMin: null, confidence: 0.99 }));
    const h = makeHarness({ llm });
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ESCALATED", { escalationReason: { kind: "alert_word" } });
    await h.text(USER, "honestly having a great time with him");
    await h.text(USER, "I'm okay now");
    const replies = h.dispatched.filter((d) => d.planId === plan.id && d.event.type === "user_reply").map((d) => d.event);
    expect(replies).toEqual([
      { type: "user_reply", label: "OK", messageId: expect.any(String) },
      { type: "user_reply", label: "OK", messageId: expect.any(String), okNow: true },
    ]);
  });
});

describe("H1 the model never produces done, home, or cancel", () => {
  const model = (command: string) => new FakeLlmProvider(() => ({ label: "COMMAND", command, extendMin: null, confidence: 0.99 }));
  it.each(["done", "home", "cancel"])("model COMMAND %s becomes AMBIGUOUS", async (command) => {
    const r = await classifyReply({ text: "welp that's that i suppose" }, model(command));
    expect(r.label).toBe("AMBIGUOUS");
    expect(r.command).toBeNull();
  });

  it("model extend is kept", async () => {
    const r = await classifyReply({ text: "staying out with them for dinner" }, model("extend"));
    expect(r).toMatchObject({ label: "COMMAND", command: "extend" });
  });

  it("dialogue: model done is not dispatched as a command", async () => {
    const h = makeHarness({ llm: model("done") });
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "CHECKING");
    await h.text(USER, "welp that's that i suppose");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "user_reply", label: "AMBIGUOUS", messageId: expect.any(String) } }]);
  });

  it("dialogue: model moving is re-confirmed before the venue changes", async () => {
    const h = makeHarness({ llm: model("moving") });
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ACTIVE");
    await h.text(USER, "gonna check out that taco place down the street");
    expect(h.dispatched.filter((d) => d.event.type === "user_command")).toEqual([]);
    expect(h.sentTo(USER).at(-1)?.template).toBe("act_new_spot");
    await h.text(USER, "yes");
    expect(h.dispatched.filter((d) => d.event.type === "user_command")).toEqual([
      { planId: plan.id, event: expect.objectContaining({ type: "user_command", command: "moving", venueText: "gonna check out that taco place down the street" }) },
    ]);
  });

  it("dialogue: deterministic done still works", async () => {
    const h = makeHarness({ llm: model("cancel") });
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ACTIVE");
    await h.text(USER, "done");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "user_command", command: "done" } }]);
  });
});
