// H2 (I11, 4.8): gdn_all_clear says "home safe" only for a home reply or a detected home arrival;
// every other way a plan ends gets honest copy. L6 (I11, 5.3): repeats after an alert word or
// distress never say "Still no reply". Real engine effects rendered with renderTemplate.
import { describe, expect, it } from "vitest";
import type { Effect, EngineEvent } from "../../apps/server/src/contracts.js";
import { renderTemplate } from "../../apps/server/src/notify/templates.js";
import { applyEvent } from "../../apps/server/src/plan/stateMachine.js";
import type { EngineContext, EnginePlan } from "../../apps/server/src/plan/types.js";
import { at, basePlan, ctxAt, fixAt, VENUE } from "../unit/core/helpers.js";

type Send = Extract<Effect, { kind: "send" }>;
const HOME = { lat: 41.95, lng: -87.65 };
const userWithHome: EngineContext["user"] = { displayName: "Alex", homeLat: HOME.lat, homeLng: HOME.lng, decoyCaller: "roommate" };

function allClear(fx: Effect[]): string | null {
  const s = fx.find((e): e is Send => e.kind === "send" && e.template === "gdn_all_clear");
  return s ? renderTemplate(s.template, s.params ?? {}, { variant: 0 }) : null;
}

const escalated = (o: Partial<EnginePlan> = {}) =>
  basePlan({ state: "ESCALATED", shareConfirmedAt: at(-20), escalatedAt: at(40), escalationReason: { kind: "no_reply", trigger: "T-OVR", minutesSilent: 18 }, ladderStep: "L3", ...o });
const silent = (kind: "alert_word" | "distress") => escalated({ escalationReason: { kind } });
const notify = (o: Partial<EnginePlan> = {}) => basePlan({ state: "ACTIVE", shareConfirmedAt: at(-20), notifyGuardianStartEnd: true, ...o });
const cmd = (command: "home" | "done" | "cancel"): EngineEvent => ({ type: "user_command", command });

describe("H2 gdn_all_clear is honest about how the plan ended", () => {
  it("home reply: home safe", () => {
    const t = allClear(applyEvent(notify(), cmd("home"), ctxAt(at(100))).effects)!;
    expect(t).toContain("Alex is home safe.");
  });

  it("home arrival detected in CLOSING: home safe", () => {
    const p = notify({ state: "CLOSING", closedAt: at(100) });
    const fixes = [fixAt(at(110), HOME.lat, HOME.lng), fixAt(at(112), HOME.lat, HOME.lng)];
    const r = applyEvent(p, { type: "fix", fix: fixes[1]! }, ctxAt(at(112), { user: userWithHome, fixes }));
    expect(r.plan.state).toBe("CLOSED");
    expect(allClear(r.effects)).toContain("home safe");
  });

  it.each([
    ["done", () => applyEvent(notify(), cmd("done"), ctxAt(at(100))), /told me the meetup is over/],
    ["cancel", () => applyEvent(notify(), cmd("cancel"), ctxAt(at(100))), /ended the plan/],
    ["cancel after alert (also STOP)", () => applyEvent(escalated(), cmd("cancel"), ctxAt(at(50))), /can't confirm they're okay/],
    ["done after alert", () => applyEvent(escalated(), cmd("done"), ctxAt(at(50))), /can't confirm they're okay/],
    ["90 min closing timeout", () => applyEvent(notify({ state: "CLOSING", closedAt: at(100) }), { type: "timer", job: "closing_timeout" }, ctxAt(at(190), { user: userWithHome })), /didn't see them get home/],
  ] as const)("%s: never 'home safe'", (_name, run, honest) => {
    const t = allClear(run().effects)!;
    expect(t).toBeTruthy();
    expect(t).not.toMatch(/home safe/i);
    expect(t).toMatch(honest);
  });

  it("4 h cap closed on an OK reply: says they replied okay", () => {
    const p = basePlan({ state: "OVERTIME", shareConfirmedAt: at(-20), notifyGuardianStartEnd: true, totalExtensionMin: 240, ladderStep: "L0", ladderClass: "overtime", ladderTrigger: "T-OVR", ladderStartedAt: at(370), ladderStepAt: at(370) });
    const t = allClear(applyEvent(p, { type: "user_reply", label: "OK", messageId: "m" }, ctxAt(at(372))).effects)!;
    expect(t).not.toMatch(/home safe/i);
    expect(t).toMatch(/replied that they're okay/);
  });

  it("home after an alert says they texted it, without certainty", () => {
    const t = allClear(applyEvent(escalated(), cmd("home"), ctxAt(at(50))).effects)!;
    expect(t).toContain("texted me that they're home");
  });
});

describe("L6 gdn_alert_repeat matches the escalation reason", () => {
  const repeat = (p: EnginePlan) => {
    const r = applyEvent(p, { type: "timer", job: "guardian_repeat" }, ctxAt(at(43), { fixes: [fixAt(at(42), VENUE.lat, VENUE.lng)] }));
    const s = r.effects.find((e): e is Send => e.kind === "send" && e.template === "gdn_alert_repeat")!;
    return renderTemplate(s.template, s.params ?? {}, { variant: 0 });
  };
  it("alert word: reminder of the alert word, not 'Still no reply'", () => {
    const t = repeat(silent("alert_word"));
    expect(t).not.toMatch(/no reply/i);
    expect(t).toContain("private alert word");
  });
  it("distress: reminder that they don't feel safe", () => {
    const t = repeat(silent("distress"));
    expect(t).not.toMatch(/no reply/i);
    expect(t).toContain("don't feel safe");
  });
  it("NOT_OK reply: no claim of silence", () => {
    const t = repeat(escalated({ escalationReason: { kind: "not_ok_reply" } }));
    expect(t).not.toMatch(/no reply/i);
  });
  it("no reply: still states the silence", () => {
    expect(repeat(escalated())).toMatch(/Still no reply from Alex \(21 min\)/);
  });
});
