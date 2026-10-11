// M1 (I3, I12): ESCALATED ends. 2 h after the last guardian-facing activity (alert, repeat,
// location update, GOT IT) the engine stops watching, closes the plan, tells the guardian
// honestly, and schedules the 24 h purge.
import { describe, expect, it } from "vitest";
import type { Effect, EngineEvent } from "../../apps/server/src/contracts.js";
import { renderTemplate } from "../../apps/server/src/notify/templates.js";
import { applyEvent, ESCALATION_END_MS } from "../../apps/server/src/plan/stateMachine.js";
import type { EnginePlan } from "../../apps/server/src/plan/types.js";
import { at, basePlan, ctxAt, fixAt, MIN, VENUE } from "../unit/core/helpers.js";

const schedOf = (fx: Effect[], kind: string) => fx.flatMap((e) => (e.kind === "schedule" && e.job.kind === kind ? [e.job] : []));
const endTimer = (p: EnginePlan): EngineEvent => ({ type: "timer", job: "escalation_end", payload: { at: p.escalationActivityAt!.toISOString() } });

describe("M1 escalation end", () => {
  const active = basePlan({ state: "ACTIVE", shareConfirmedAt: at(-20) });

  it("escalating schedules escalation_end 2 h out", () => {
    const r = applyEvent(active, { type: "alert_word", messageId: "m" }, ctxAt(at(30)));
    expect(ESCALATION_END_MS).toBe(120 * MIN);
    expect(schedOf(r.effects, "escalation_end").map((j) => j.runAt)).toEqual([at(150)]);
  });

  it("GOT IT and later updates push the end out; a stale timer does nothing", () => {
    const esc = applyEvent(active, { type: "alert_word", messageId: "m" }, ctxAt(at(30))).plan;
    const stale = endTimer(esc);
    const acked = applyEvent(esc, { type: "guardian_ack" }, ctxAt(at(40)));
    expect(schedOf(acked.effects, "escalation_end").map((j) => j.runAt)).toEqual([at(160)]);
    expect(applyEvent(acked.plan, stale, ctxAt(at(150))).plan.state).toBe("ESCALATED");
    const moved = applyEvent(acked.plan, { type: "timer", job: "guardian_update" }, ctxAt(at(45), { fixes: [fixAt(at(45), VENUE.lat + 0.01, VENUE.lng)] }));
    expect(schedOf(moved.effects, "escalation_end").map((j) => j.runAt)).toEqual([at(165)]);
  });

  it("the end closes the plan, stops the watch, tells the guardian honestly, and schedules the purge", () => {
    const esc = applyEvent(active, { type: "alert_word", messageId: "m" }, ctxAt(at(30))).plan;
    const r = applyEvent(esc, endTimer(esc), ctxAt(at(150)));
    expect(r.plan.state).toBe("CLOSED");
    expect(r.effects.some((e) => e.kind === "stop_watch")).toBe(true);
    expect(schedOf(r.effects, "purge")).toHaveLength(1);
    const g = r.effects.find((e): e is Extract<Effect, { kind: "send" }> => e.kind === "send" && e.to === "guardian")!;
    const text = renderTemplate(g.template, g.params ?? {}, { variant: 0 });
    expect(text).toContain("I can't confirm they're okay");
    expect(text).not.toMatch(/home safe/i);
    // I9: nothing to the user about the alert.
    expect(r.effects.filter((e) => e.kind === "send" && e.to === "user")).toEqual([]);
  });
});
