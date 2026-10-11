// notifyGuardianStartEnd (4.4.2, 4.8): the guardian hears when the meetup starts, with plan
// details but never a location (I4), and only after they accepted (I1).
import { describe, expect, it } from "vitest";
import type { Effect } from "../../apps/server/src/contracts.js";
import { renderTemplate } from "../../apps/server/src/notify/templates.js";
import { applyEvent } from "../../apps/server/src/plan/stateMachine.js";
import { at, basePlan, ctxAt, fixAt, VENUE } from "../unit/core/helpers.js";

type Send = Extract<Effect, { kind: "send" }>;
const started = (fx: Effect[]) => fx.filter((e): e is Send => e.kind === "send" && e.template === "gdn_plan_started");

describe("gdn_plan_started", () => {
  it("sent at the start when notifyGuardianStartEnd, without location", () => {
    const p = basePlan({ state: "PRE_MEETUP", notifyGuardianStartEnd: true, shareConfirmedAt: at(-20) });
    const r = applyEvent(p, { type: "timer", job: "start" }, ctxAt(at(0), { fixes: [fixAt(at(0), VENUE.lat, VENUE.lng)] }));
    const s = started(r.effects);
    expect(s).toHaveLength(1);
    expect(s[0]!.params?.fix).toBeUndefined();
    const text = renderTemplate(s[0]!.template, s[0]!.params ?? {}, { variant: 0 });
    expect(text).toContain("Alex is starting a date with Jordan (Hinge).");
    expect(text).not.toMatch(/maps\.apple|41\.9/);
  });

  it("not sent without the flag, or without an accepted guardian", () => {
    expect(started(applyEvent(basePlan({ state: "PRE_MEETUP" }), { type: "timer", job: "start" }, ctxAt(at(0))).effects)).toEqual([]);
    const pending = ctxAt(at(0), { guardian: { displayName: "Priya", linkStatus: "pending", stopped: false } });
    expect(started(applyEvent(basePlan({ state: "PRE_MEETUP", notifyGuardianStartEnd: true }), { type: "timer", job: "start" }, pending).effects)).toEqual([]);
  });
});
