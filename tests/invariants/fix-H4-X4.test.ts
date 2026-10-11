// H4 (I16, I8, 4.4.6): edits after arming reschedule the timers that depend on the edited
// fields, and move straight to PRE_MEETUP or ACTIVE when the new start is near or past.
// X4: a plan stuck in AWAITING_GUARDIAN past its start tells the user once that it expired.
import { describe, expect, it } from "vitest";
import type { Effect, JobKind } from "../../apps/server/src/contracts.js";
import { applyEvent, T_MINUS_MS } from "../../apps/server/src/plan/stateMachine.js";
import { at, basePlan, ctxAt, MIN } from "../unit/core/helpers.js";

const scheduled = (fx: Effect[]) => fx.flatMap((e) => (e.kind === "schedule" ? [{ kind: e.job.kind, runAt: e.job.runAt }] : []));
const cancelled = (fx: Effect[]) => fx.flatMap((e) => (e.kind === "cancel_jobs" ? (e.kinds ?? ["*" as JobKind]) : []));
const userSends = (fx: Effect[]) => fx.flatMap((e) => (e.kind === "send" && e.to === "user" ? [e.template] : []));

describe("H4 plan_edited", () => {
  it("ARMED, start moved later: t_minus_30 and start rescheduled", () => {
    const p = basePlan({ state: "ARMED", startAt: at(240), endAt: at(360) }); // edited fields already written
    const r = applyEvent(p, { type: "plan_edited", fields: ["startAt", "endAt"] }, ctxAt(at(0)));
    expect(r.plan.state).toBe("ARMED");
    expect(cancelled(r.effects)).toEqual(expect.arrayContaining(["t_minus_30", "start"]));
    expect(scheduled(r.effects)).toEqual(
      expect.arrayContaining([
        { kind: "t_minus_30", runAt: new Date(at(240).getTime() - T_MINUS_MS) },
        { kind: "start", runAt: at(240) },
      ]),
    );
  });

  it("ARMED, start moved to within 30 min: straight to PRE_MEETUP with the Find My request", () => {
    const p = basePlan({ state: "ARMED", startAt: at(20), endAt: at(140) });
    const r = applyEvent(p, { type: "plan_edited", fields: ["startAt"] }, ctxAt(at(0)));
    expect(r.plan.state).toBe("PRE_MEETUP");
    expect(r.effects.some((e) => e.kind === "request_location")).toBe(true);
    expect(scheduled(r.effects)).toContainEqual({ kind: "start", runAt: at(20) });
  });

  it("ARMED, start moved into the past: straight to ACTIVE", () => {
    const p = basePlan({ state: "ARMED", startAt: at(-5), endAt: at(115) });
    const r = applyEvent(p, { type: "plan_edited", fields: ["startAt"] }, ctxAt(at(0)));
    expect(r.plan.state).toBe("ACTIVE");
    expect(scheduled(r.effects).map((j) => j.kind)).toContain("end_grace");
  });

  it("PRE_MEETUP, start moved hours later: back to ARMED, location request stopped", () => {
    const p = basePlan({ state: "PRE_MEETUP", startAt: at(300), endAt: at(420), locRequestedAt: at(-1) });
    const r = applyEvent(p, { type: "plan_edited", fields: ["startAt"] }, ctxAt(at(0)));
    expect(r.plan.state).toBe("ARMED");
    expect(r.plan.locRequestedAt).toBeNull();
    expect(cancelled(r.effects)).toEqual(expect.arrayContaining(["loc_poll", "loc_reminder", "start"]));
    expect(r.effects.some((e) => e.kind === "stop_watch")).toBe(true);
    expect(scheduled(r.effects).map((j) => j.kind)).toEqual(expect.arrayContaining(["t_minus_30", "start"]));
  });

  it("ACTIVE, end moved: end_grace rescheduled for the new end", () => {
    const p = basePlan({ state: "ACTIVE", startAt: at(0), endAt: at(180), shareConfirmedAt: at(-20) });
    const r = applyEvent(p, { type: "plan_edited", fields: ["endAt"] }, ctxAt(at(30)));
    expect(r.plan.state).toBe("ACTIVE");
    expect(scheduled(r.effects)).toContainEqual({ kind: "end_grace", runAt: new Date(at(180).getTime() + 15 * MIN) });
  });

  it("plans more than 7 days out get a reconfirm job after an edit", () => {
    const p = basePlan({ state: "ARMED", startAt: at(9 * 24 * 60), endAt: at(9 * 24 * 60 + 120) });
    const r = applyEvent(p, { type: "plan_edited", fields: ["startAt"] }, ctxAt(at(0)));
    expect(scheduled(r.effects).map((j) => j.kind)).toContain("reconfirm");
  });

  it("the edit sends nothing itself (the dialogue confirms the changed fields)", () => {
    const p = basePlan({ state: "ARMED", startAt: at(240), endAt: at(360) });
    expect(userSends(applyEvent(p, { type: "plan_edited", fields: ["startAt"] }, ctxAt(at(0))).effects)).toEqual([]);
  });
});

describe("X4 AWAITING_GUARDIAN past its start", () => {
  it("arming without a guardian schedules the expiry at the start", () => {
    const p = basePlan({ state: "DRAFT", startAt: at(60), endAt: at(180) });
    const r = applyEvent(p, { type: "arm", guardianAccepted: false }, ctxAt(at(0), { guardian: { displayName: "Priya", linkStatus: "pending", stopped: false } }));
    expect(r.plan.state).toBe("AWAITING_GUARDIAN");
    expect(scheduled(r.effects)).toContainEqual({ kind: "draft_expire", runAt: at(60) });
  });

  it("at the start the plan expires and the user is told once", () => {
    const p = basePlan({ state: "AWAITING_GUARDIAN", startAt: at(60), endAt: at(180) });
    const r = applyEvent(p, { type: "timer", job: "draft_expire" }, ctxAt(at(60)));
    expect(r.plan.state).toBe("EXPIRED");
    expect(userSends(r.effects)).toEqual(["plan_expired_unarmed"]);
    const again = applyEvent(r.plan, { type: "timer", job: "draft_expire" }, ctxAt(at(61)));
    expect(userSends(again.effects)).toEqual([]);
  });

  it("an edit while awaiting the guardian moves the expiry to the new start", () => {
    const p = basePlan({ state: "AWAITING_GUARDIAN", startAt: at(300), endAt: at(420) });
    const r = applyEvent(p, { type: "plan_edited", fields: ["startAt"] }, ctxAt(at(0)));
    expect(cancelled(r.effects)).toContain("draft_expire");
    expect(scheduled(r.effects)).toContainEqual({ kind: "draft_expire", runAt: at(300) });
  });
});
