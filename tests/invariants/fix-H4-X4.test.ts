// H4 (I16, I8, 4.4.6): edits after arming reschedule the timers that depend on the edited
// fields, and move straight to PRE_MEETUP or ACTIVE when the new start is near or past.
// X4 (revised 2026-10-10 after the live test): a plan stuck in AWAITING_GUARDIAN waits until its
// planned END, never expires the instant its start passes, and arms the moment the guardian accepts.
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

describe("X4 revised: AWAITING_GUARDIAN waits until the planned end", () => {
  const pending = { guardian: { displayName: "Madhu", linkStatus: "pending" as const, stopped: false } };

  it("arming without a guardian schedules the expiry at the planned end", () => {
    const p = basePlan({ state: "DRAFT", startAt: at(60), endAt: at(180) });
    const r = applyEvent(p, { type: "arm", guardianAccepted: false }, ctxAt(at(0), pending));
    expect(r.plan.state).toBe("AWAITING_GUARDIAN");
    expect(scheduled(r.effects)).toContainEqual({ kind: "draft_expire", runAt: at(180) });
    expect(userSends(r.effects)).toEqual(["plan_awaiting_guardian"]);
  });

  it("live bug: a plan starting NOW does not expire instantly; the user is told once, honestly", () => {
    const p = basePlan({ state: "DRAFT", startAt: at(0), endAt: at(60) });
    const r = applyEvent(p, { type: "arm", guardianAccepted: false }, ctxAt(at(0), pending));
    expect(r.plan.state).toBe("AWAITING_GUARDIAN");
    expect(userSends(r.effects)).toEqual(["plan_awaiting_guardian"]); // never plan_expired_unarmed here
    const send = r.effects.find((e) => e.kind === "send" && e.template === "plan_awaiting_guardian") as Extract<Effect, { kind: "send" }>;
    expect(send.params?.soon).toBe(true);
    expect(scheduled(r.effects)).toContainEqual({ kind: "draft_expire", runAt: at(60) });
    // The expiry timer firing early (start passed) changes nothing.
    const early = applyEvent(r.plan, { type: "timer", job: "draft_expire" }, ctxAt(at(1), pending));
    expect(early.plan.state).toBe("AWAITING_GUARDIAN");
    expect(userSends(early.effects)).toEqual([]);
  });

  it("at the planned end the plan expires with the honest copy, once", () => {
    const p = basePlan({ state: "AWAITING_GUARDIAN", startAt: at(60), endAt: at(180) });
    expect(applyEvent(p, { type: "timer", job: "draft_expire" }, ctxAt(at(60))).plan.state).toBe("AWAITING_GUARDIAN");
    const r = applyEvent(p, { type: "timer", job: "draft_expire" }, ctxAt(at(180)));
    expect(r.plan.state).toBe("EXPIRED");
    expect(userSends(r.effects)).toEqual(["plan_expired_unarmed"]);
    const again = applyEvent(r.plan, { type: "timer", job: "draft_expire" }, ctxAt(at(181)));
    expect(userSends(again.effects)).toEqual([]);
  });

  it("an edit while awaiting the guardian moves the expiry to the new end", () => {
    const p = basePlan({ state: "AWAITING_GUARDIAN", startAt: at(300), endAt: at(420) });
    const r = applyEvent(p, { type: "plan_edited", fields: ["startAt"] }, ctxAt(at(0)));
    expect(cancelled(r.effects)).toContain("draft_expire");
    expect(scheduled(r.effects)).toContainEqual({ kind: "draft_expire", runAt: at(420) });
  });

  it("guardian accepts well before the start: ARMED with normal timers", () => {
    const p = basePlan({ state: "AWAITING_GUARDIAN", startAt: at(120), endAt: at(240) });
    const r = applyEvent(p, { type: "guardian_accepted" }, ctxAt(at(0)));
    expect(r.plan.state).toBe("ARMED");
    expect(scheduled(r.effects).map((j) => j.kind)).toEqual(expect.arrayContaining(["t_minus_30", "start"]));
  });

  it("guardian accepts within 30 min of the start: straight to PRE_MEETUP with the Find My request", () => {
    const p = basePlan({ state: "AWAITING_GUARDIAN", startAt: at(10), endAt: at(130) });
    const r = applyEvent(p, { type: "guardian_accepted" }, ctxAt(at(0)));
    expect(r.plan.state).toBe("PRE_MEETUP");
    expect(r.effects.some((e) => e.kind === "request_location")).toBe(true);
    expect(scheduled(r.effects)).toContainEqual({ kind: "start", runAt: at(10) });
    expect(cancelled(r.effects)).toContain("draft_expire");
    expect(userSends(r.effects)[0]).toBe("plan_armed_now");
  });

  it("guardian accepts after the start but before the end: straight to ACTIVE, location requested", () => {
    const p = basePlan({ state: "AWAITING_GUARDIAN", startAt: at(0), endAt: at(60) });
    const r = applyEvent(p, { type: "guardian_accepted" }, ctxAt(at(20)));
    expect(r.plan.state).toBe("ACTIVE");
    expect(r.effects.some((e) => e.kind === "request_location")).toBe(true);
    expect(scheduled(r.effects).map((j) => j.kind)).toContain("end_grace");
    expect(cancelled(r.effects)).toContain("draft_expire");
    const sends = userSends(r.effects);
    expect(sends[0]).toBe("plan_armed_now");
    expect(sends).toContain("loc_request_intro");
    expect(sends).not.toContain("loc_time_only"); // the share was just requested; give it time
  });

  it("guardian never accepts the late share: time-only notice once the poll window ends", () => {
    const p = basePlan({ state: "AWAITING_GUARDIAN", startAt: at(0), endAt: at(60) });
    const r = applyEvent(p, { type: "guardian_accepted" }, ctxAt(at(20)));
    const gaveUp = applyEvent(r.plan, { type: "timer", job: "loc_poll" }, ctxAt(at(35), { share: { visible: false, expiresAt: null } }));
    expect(userSends(gaveUp.effects)).toEqual(["loc_time_only"]);
  });
});
