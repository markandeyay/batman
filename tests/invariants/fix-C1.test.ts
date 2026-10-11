// C1 (I4, I11, spec 5.1): the engine's send params must be the canonical TemplateParams that
// notify/templates.ts reads. Real engine effects are rendered with renderTemplate and nothing
// else (no executor defaults), so a renamed or reshaped key shows up as missing copy.
import { describe, expect, it } from "vitest";
import { TRIGGER_IDS, type Effect, type EngineEvent, type TriggerId } from "../../apps/server/src/contracts.js";
import { renderTemplate } from "../../apps/server/src/notify/templates.js";
import { applyEvent } from "../../apps/server/src/plan/stateMachine.js";
import type { EngineContext, EnginePlan } from "../../apps/server/src/plan/types.js";
import { at, basePlan, ctxAt, fixAt, VENUE } from "../unit/core/helpers.js";

const TZ = "America/Los_Angeles"; // not the fallback tz, so a lost tz shows up
const NOW = at(30); // 23:30Z = 4:30 PM PDT
const FIX = fixAt(at(28), VENUE.lat, VENUE.lng, 20); // 2 min old, +-20 m
const MAPS = "https://maps.apple.com/?ll=41.9172,-87.7067&q=Alex";

function ctx(now = NOW, extra: Partial<EngineContext> = {}): EngineContext {
  return ctxAt(now, { timeZone: TZ, fixes: [FIX], ...extra });
}

type Send = Extract<Effect, { kind: "send" }>;
function sends(fx: Effect[], to: "user" | "guardian"): Send[] {
  return fx.filter((e): e is Send => e.kind === "send" && e.to === to);
}
function render(e: Send): string {
  return renderTemplate(e.template, e.params ?? {}, { variant: 0 });
}
function guardianAlert(fx: Effect[]): string {
  const a = sends(fx, "guardian").find((e) => e.template === "gdn_alert");
  expect(a, "gdn_alert sent").toBeDefined();
  return render(a!);
}

const active = (o: Partial<EnginePlan> = {}) => basePlan({ state: "ACTIVE", shareConfirmedAt: at(-20), arrivedAt: at(2), arrivalLineSent: true, ...o });
const atL2 = (trigger: TriggerId | null, o: Partial<EnginePlan> = {}) =>
  active({
    state: "CHECKING",
    ladderStep: "L2",
    ladderClass: "soft",
    ladderTrigger: trigger,
    ladderStartedAt: at(22),
    ladderStepAt: at(27),
    ladderMessages: 3,
    ...o,
  });
const l3 = (p: EnginePlan): EngineEvent => ({ type: "timer", job: "ladder", payload: { step: "L3", token: p.ladderStartedAt!.toISOString() } });

function expectLocation(text: string): void {
  expect(text).toContain(MAPS);
  expect(text).toContain("±20 m");
  expect(text).toContain("2 min ago");
  expect(text).toContain("4:28 PM"); // fix time in the user's timezone
}

const REASON_BY_TRIGGER: Record<TriggerId, RegExp> = {
  "T-OVR": /Alex hasn't answered my last 3 messages \(8 min\) during a date with Jordan \(Hinge\)\./,
  "T-DEP-WALK": /Alex left the meetup on foot and hasn't replied \(8 min\) during a date with Jordan/,
  "T-DEP-CAR": /Alex left the meetup by car and hasn't replied \(8 min\)/,
  "T-DEP-CAR-THEIRS": /Alex left the meetup by car and hasn't replied \(8 min\)/,
  "T-FAR": /Alex is far from the meetup spot and hasn't replied/,
  "T-DARK": /Alex's location stopped updating and they haven't replied/,
  "T-NOARRIVE": /doesn't seem to have arrived at the meetup spot/,
  "T-MKT-LONG": /running much longer than planned/,
  "T-VENUE-CHG": /Alex moved to a new spot and hasn't replied/,
  "T-POST-EXIT": /Alex wanted a way out of the meetup and hasn't replied since/,
};

describe("C1 engine params render through the real templates", () => {
  it.each(TRIGGER_IDS.map((t) => [t]))("no_reply escalation via %s: reason, map link, accuracy, age, timezone", (trigger) => {
    const p = atL2(trigger);
    const r = applyEvent(p, l3(p), ctx());
    expect(r.plan.state).toBe("ESCALATED");
    const text = guardianAlert(r.effects);
    expect(text).toMatch(REASON_BY_TRIGGER[trigger]);
    expectLocation(text);
    expect(text).toContain("Plan: Lula Cafe, 4:00 to 6:00 PM. Alex is driving themselves.");
  });

  it("alert word: private alert word line, never 'hasn't answered'", () => {
    const r = applyEvent(active(), { type: "alert_word", messageId: "m1" }, ctx());
    const text = guardianAlert(r.effects);
    expect(text).toContain("Alex sent me their private alert word. That means they want help but may not be able to talk.");
    expect(text).not.toMatch(/hasn't answered/);
    expectLocation(text);
  });

  it("distress: quotes nothing, says they don't feel safe", () => {
    const r = applyEvent(active(), { type: "distress", messageId: "m1" }, ctx());
    const text = guardianAlert(r.effects);
    expect(text).toContain("Alex texted me that they don't feel safe.");
    expect(text).not.toMatch(/hasn't answered/);
    expectLocation(text);
  });

  it("NOT_OK reply: honest reason line", () => {
    const p = atL2("T-DEP-WALK");
    const r = applyEvent(p, { type: "user_reply", label: "NOT_OK", messageId: "m1" }, ctx());
    const text = guardianAlert(r.effects);
    expect(text).toMatch(/Alex replied to my message in a way that sounded like they're not okay during a date with Jordan/);
    expectLocation(text);
  });

  it("an upgraded reason (alert word during a no-reply escalation) is relayed with the right line", () => {
    const p = atL2("T-OVR");
    const esc = applyEvent(p, l3(p), ctx()).plan;
    const r = applyEvent(esc, { type: "alert_word", messageId: "m9" }, ctx(at(31)));
    expect(guardianAlert(r.effects)).toContain("sent me their private alert word");
  });

  it("marketplace and viewing plans are named, not 'a meetup'", () => {
    const mk = applyEvent(active({ type: "marketplace", buyOrSell: "sell", counterpartName: null, counterpartSource: null }), { type: "distress", messageId: "m" }, ctx());
    expect(guardianAlert(mk.effects)).toMatch(/Marketplace sale|Plan:/);
    const p = atL2("T-OVR", { type: "viewing", counterpartName: null, counterpartSource: null });
    const v = applyEvent(p, l3(p), ctx());
    const text = guardianAlert(v.effects);
    expect(text).toContain("during an apartment viewing.");
    expect(text).not.toContain("a meetup");
  });

  it("time-only plan: says it has no location for this meetup", () => {
    const p = atL2("T-OVR", { locationMode: "none", shareConfirmedAt: null });
    const r = applyEvent(p, l3(p), ctx(NOW, { fixes: [] }));
    expect(guardianAlert(r.effects)).toContain("I don't have Alex's location for this meetup.");
  });

  it("gdn_alert_repeat and gdn_location_update keep the map link, accuracy, and age", () => {
    const esc = applyEvent(active(), { type: "alert_word", messageId: "m1" }, ctx()).plan;
    const later = at(33);
    const fresh = fixAt(at(31), VENUE.lat, VENUE.lng, 20);
    const rep = applyEvent(esc, { type: "timer", job: "guardian_repeat" }, ctx(later, { fixes: [fresh] }));
    const repText = render(sends(rep.effects, "guardian").find((e) => e.template === "gdn_alert_repeat")!);
    expect(repText).toContain(MAPS);
    expect(repText).toContain("2 min ago");
    const loc = applyEvent(esc, { type: "guardian_location_request" }, ctx(later, { fixes: [fresh] }));
    const locText = render(sends(loc.effects, "guardian").find((e) => e.template === "gdn_location_update")!);
    expect(locText).toContain(MAPS);
    expect(locText).toContain("±20 m");
    expect(locText).toContain("2 min ago");
    expect(locText).toContain("4:31 PM");
  });

  it("every guardian template the engine emits renders with the user's name", () => {
    const p = atL2("T-OVR");
    const esc = applyEvent(p, l3(p), ctx()).plan;
    const okR = applyEvent(esc, { type: "user_reply", label: "OK", messageId: "m2" }, ctx(at(35)));
    const all = [...okR.effects, ...applyEvent(esc, { type: "user_command", command: "home" }, ctx(at(35))).effects];
    const texts = sends(all, "guardian").map(render);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    for (const t of texts) expect(t).toContain("Alex");
  });

  it("close_done_ack tells the truth about whether the plan closed", () => {
    const closed = applyEvent(active(), { type: "user_command", command: "done" }, ctx());
    expect(closed.plan.state).toBe("CLOSED");
    expect(render(sends(closed.effects, "user").find((e) => e.template === "close_done_ack")!)).toMatch(/Plan closed/);
    const home = { displayName: "Alex", homeLat: 41.95, homeLng: -87.65, decoyCaller: "roommate" as const };
    const closing = applyEvent(active(), { type: "user_command", command: "done" }, ctx(NOW, { user: home }));
    expect(closing.plan.state).toBe("CLOSING");
    expect(render(sends(closing.effects, "user").find((e) => e.template === "close_done_ack")!)).toMatch(/Text me "home"/);
  });
});
