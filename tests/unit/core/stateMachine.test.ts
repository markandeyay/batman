import { afterAll, describe, expect, it } from "vitest";
import type { Effect, EngineEvent, JobKind, PlanState } from "../../../apps/server/src/contracts.js";
import { applyEvent, matchRow, TRANSITIONS } from "../../../apps/server/src/plan/stateMachine.js";
import type { EngineContext, EnginePlan } from "../../../apps/server/src/plan/types.js";
import { VENUE, at, basePlan, ctxAt, fixAt, fixFromVenue, T0 } from "./helpers.js";

const hit = new Set<string>();

function apply(plan: EnginePlan, event: EngineEvent, ctx: EngineContext) {
  const id = matchRow(plan, event, ctx);
  if (id) hit.add(id);
  const out = applyEvent(plan, event, ctx);
  const fx = out.effects.filter((e) => e.kind !== "audit");
  return { ...out, fx, row: id };
}

const sends = (fx: Effect[]) =>
  fx.filter((e): e is Extract<Effect, { kind: "send" }> => e.kind === "send").map((e) => `${e.to}:${e.template}`);
const sched = (fx: Effect[], kind?: JobKind) =>
  fx.filter((e): e is Extract<Effect, { kind: "schedule" }> => e.kind === "schedule" && (!kind || e.job.kind === kind)).map((e) => e.job);
const kinds = (fx: Effect[]) => fx.map((e) => (e.kind === "send" ? `send:${e.to}:${e.template}` : e.kind === "call" ? `call:${e.to}:${e.script}` : e.kind));
const timer = (job: JobKind, payload?: Record<string, unknown>): EngineEvent => (payload ? { type: "timer", job, payload } : { type: "timer", job });

/** ACTIVE plan with Find My live and arrival done. */
function active(o: Partial<EnginePlan> = {}): EnginePlan {
  return basePlan({ state: "ACTIVE", shareConfirmedAt: at(-25), arrivedAt: at(2), arrivalLineSent: true, ...o });
}

/** A plan in CHECKING at `step` with ladder started at T0+30. */
function checking(step: "L0" | "L1" | "L2", o: Partial<EnginePlan> = {}): EnginePlan {
  return active({
    state: "CHECKING",
    ladderStep: step,
    ladderClass: "soft",
    ladderTrigger: "T-DEP-WALK",
    ladderStartedAt: at(30),
    ladderStepAt: at(30 + (step === "L0" ? 0 : step === "L1" ? 5 : 9)),
    lastCheckinMessageId: "chk-1",
    ...o,
  });
}

function escalated(o: Partial<EnginePlan> = {}): EnginePlan {
  return active({
    state: "ESCALATED",
    ladderStep: "L3",
    escalatedAt: at(40),
    escalationReason: { kind: "no_reply", trigger: "T-DEP-WALK", minutesSilent: 12 },
    ...o,
  });
}

describe("6.2 DRAFT and arming (I1)", () => {
  it("DRAFT + go + guardian accepted -> ARMED, schedules T-30 and start", () => {
    const r = apply(basePlan(), { type: "arm", guardianAccepted: true }, ctxAt(at(-240)));
    expect(r.row).toBe("draft-go-armed");
    expect(r.plan.state).toBe("ARMED");
    expect(sends(r.fx)).toEqual(["user:plan_locked_in"]);
    expect(sched(r.fx, "t_minus_30")[0]!.runAt).toEqual(at(-30));
    expect(sched(r.fx, "start")[0]!.runAt).toEqual(T0);
    expect(r.fx).toContainEqual({ kind: "cancel_jobs", kinds: ["draft_expire"] });
    expect(sched(r.fx, "reconfirm")).toEqual([]);
  });

  it("start sooner than 30 min requests location immediately", () => {
    const r = apply(basePlan(), { type: "arm", guardianAccepted: true }, ctxAt(at(-10)));
    expect(sched(r.fx, "t_minus_30")[0]!.runAt).toEqual(at(-10));
  });

  it("plans more than 7 days out get a reconfirm the day before", () => {
    const r = apply(basePlan(), { type: "arm", guardianAccepted: true }, ctxAt(at(-8 * 24 * 60)));
    expect(sched(r.fx, "reconfirm")[0]!.runAt).toEqual(at(-24 * 60));
  });

  it("computes high vigilance at arming (marketplace at a private address)", () => {
    const p = basePlan({ type: "marketplace", privateAddress: true });
    expect(apply(p, { type: "arm", guardianAccepted: true }, ctxAt(at(-60))).plan.highVigilance).toBe(true);
    expect(apply(basePlan({ userNervous: true }), { type: "arm", guardianAccepted: true }, ctxAt(at(-60))).plan.highVigilance).toBe(true);
    expect(apply(basePlan(), { type: "arm", guardianAccepted: true }, ctxAt(at(-60))).plan.highVigilance).toBe(false);
  });

  it("DRAFT + go, guardian not accepted -> AWAITING_GUARDIAN (S-18)", () => {
    const r = apply(basePlan(), { type: "arm", guardianAccepted: false }, ctxAt(at(-60)));
    expect(r.row).toBe("draft-go-awaiting");
    expect(r.plan.state).toBe("AWAITING_GUARDIAN");
    expect(sends(r.fx)).toEqual(["user:plan_awaiting_guardian"]);
    expect(sched(r.fx, "draft_expire")[0]!.runAt).toEqual(at(120));
  });

  it("I1: arming needs the link to be accepted in the store too, not just the event", () => {
    const ctx = ctxAt(at(-60), { guardian: { displayName: "Priya", linkStatus: "pending", stopped: false } });
    expect(apply(basePlan(), { type: "arm", guardianAccepted: true }, ctx).plan.state).toBe("AWAITING_GUARDIAN");
  });

  it("incomplete plans are not armed", () => {
    const r = apply(basePlan({ venueText: null }), { type: "arm", guardianAccepted: true }, ctxAt(at(-60)));
    expect(r.row).toBe("draft-go-incomplete");
    expect(r.plan.state).toBe("DRAFT");
    expect(r.fx).toEqual([]);
  });

  it("AWAITING_GUARDIAN + guardian YES -> ARMED with plan_armed_now", () => {
    const r = apply(basePlan({ state: "AWAITING_GUARDIAN" }), { type: "guardian_accepted" }, ctxAt(at(-60)));
    expect(r.row).toBe("awaiting-guardian-yes");
    expect(r.plan.state).toBe("ARMED");
    expect(sends(r.fx)).toEqual(["user:plan_armed_now"]);
  });

  it("guardian YES while DRAFT does nothing", () => {
    const r = apply(basePlan(), { type: "guardian_accepted" }, ctxAt(at(-60)));
    expect(r.plan.state).toBe("DRAFT");
    expect(r.fx).toEqual([]);
  });

  it("reconfirm timer asks the user to confirm the time", () => {
    const r = apply(basePlan({ state: "ARMED" }), timer("reconfirm"), ctxAt(at(-24 * 60)));
    expect(sends(r.fx)).toEqual(["user:plan_time_confirm_ask"]);
  });

  it("draft expires after 12 h; AWAITING_GUARDIAN expires when the window passes", () => {
    const p = basePlan({ createdAt: at(-240) });
    expect(apply(p, timer("draft_expire"), ctxAt(at(-240 + 11 * 60))).plan.state).toBe("DRAFT");
    const r = apply(p, timer("draft_expire"), ctxAt(at(-240 + 12 * 60)));
    expect(r.row).toBe("draft-expire");
    expect(r.plan.state).toBe("EXPIRED");
    expect(sends(r.fx)).toEqual([]);
    expect(sched(r.fx, "purge")).toHaveLength(1);
    const aw = basePlan({ state: "AWAITING_GUARDIAN" });
    expect(apply(aw, timer("draft_expire"), ctxAt(at(119))).plan.state).toBe("AWAITING_GUARDIAN");
    expect(apply(aw, timer("draft_expire"), ctxAt(at(120))).plan.state).toBe("EXPIRED");
  });
});

describe("6.2 / 4.5 pre-meetup and location", () => {
  it("ARMED + T-30 -> PRE_MEETUP, Find My request, poll, reminder", () => {
    const r = apply(basePlan({ state: "ARMED" }), timer("t_minus_30"), ctxAt(at(-30)));
    expect(r.row).toBe("armed-t30-premeetup");
    expect(r.plan.state).toBe("PRE_MEETUP");
    expect(kinds(r.fx)).toEqual(["send:user:loc_request_intro", "request_location", "schedule", "schedule"]);
    expect(sched(r.fx, "loc_poll")[0]!.runAt).toEqual(new Date(at(-30).getTime() + 30_000));
    expect(sched(r.fx, "loc_reminder")[0]!.runAt).toEqual(at(-15));
  });

  it("skips the request when the share is already visible past end + 60 (4.5 step 1)", () => {
    const r = apply(basePlan({ state: "ARMED" }), timer("t_minus_30"), ctxAt(at(-30), { share: { visible: true, expiresAt: at(181) } }));
    expect(kinds(r.fx)).toEqual(["start_watch"]);
    expect(r.plan.shareConfirmedAt).toEqual(at(-30));
  });

  it("reminder is scheduled no later than 5 min before start", () => {
    const r = apply(basePlan({ state: "ARMED" }), timer("t_minus_30"), ctxAt(at(-12)));
    expect(sched(r.fx, "loc_reminder")[0]!.runAt).toEqual(at(-5));
  });

  it("loc_poll: accepted share -> tapback, start watcher, stop polling", () => {
    const p = basePlan({ state: "PRE_MEETUP", locRequestedAt: at(-30) });
    const r = apply(p, timer("loc_poll"), ctxAt(at(-29), { share: { visible: true, expiresAt: null }, lastUserMessageId: "u-5" }));
    expect(r.row).toBe("loc-poll");
    expect(kinds(r.fx)).toEqual(["cancel_jobs", "react", "start_watch"]);
    expect(r.plan.shareConfirmedAt).toEqual(at(-29));
  });

  it("loc_poll: not yet visible -> poll again until 15 min", () => {
    const p = basePlan({ state: "PRE_MEETUP", locRequestedAt: at(-30) });
    expect(sched(apply(p, timer("loc_poll"), ctxAt(at(-20), { share: { visible: false, expiresAt: null } })).fx, "loc_poll")).toHaveLength(1);
    expect(sched(apply(p, timer("loc_poll"), ctxAt(at(-15), { share: { visible: false, expiresAt: null } })).fx, "loc_poll")).toHaveLength(0);
  });

  it("location_shared asks once to extend a share that ends too early (4.5 step 5)", () => {
    const p = basePlan({ state: "PRE_MEETUP", locRequestedAt: at(-30) });
    const r = apply(p, { type: "location_shared", expiresAt: at(150) }, ctxAt(at(-25)));
    expect(r.row).toBe("loc-shared");
    expect(sends(r.fx)).toEqual(["user:loc_extend_ask"]);
    const again = apply(r.plan, { type: "location_shared", expiresAt: at(150) }, ctxAt(at(-24)));
    expect(sends(again.fx)).toEqual([]);
  });

  it("I3: location_shared outside a window is ignored", () => {
    expect(apply(basePlan({ state: "ARMED" }), { type: "location_shared", expiresAt: null }, ctxAt(at(-60))).fx).toEqual([]);
  });

  it("location_not_shared -> time-only with one notice", () => {
    const r = apply(basePlan({ state: "PRE_MEETUP" }), { type: "location_not_shared" }, ctxAt(at(-20)));
    expect(r.row).toBe("loc-not-shared");
    expect(r.plan.locationMode).toBe("none");
    expect(sends(r.fx)).toEqual(["user:loc_time_only"]);
    expect(sends(apply(r.plan, { type: "location_not_shared" }, ctxAt(at(-19))).fx)).toEqual([]);
  });

  it("loc_reminder is sent once and only while not shared", () => {
    const p = basePlan({ state: "PRE_MEETUP", locRequestedAt: at(-30) });
    const r = apply(p, timer("loc_reminder"), ctxAt(at(-15)));
    expect(r.row).toBe("loc-reminder");
    expect(sends(r.fx)).toEqual(["user:loc_reminder"]);
    expect(apply(r.plan, timer("loc_reminder"), ctxAt(at(-14))).fx).toEqual([]);
    expect(apply({ ...p, shareConfirmedAt: at(-20) }, timer("loc_reminder"), ctxAt(at(-15))).fx).toEqual([]);
  });
});

describe("6.2 start, arrival, mid-check", () => {
  it("PRE_MEETUP + start -> ACTIVE: end timer, mid-check at 45%, risk ticks", () => {
    const p = basePlan({ state: "PRE_MEETUP", shareConfirmedAt: at(-20) });
    const r = apply(p, timer("start"), ctxAt(T0));
    expect(r.row).toBe("start-active");
    expect(r.plan.state).toBe("ACTIVE");
    expect(sched(r.fx, "end_grace")[0]!.runAt).toEqual(at(135));
    expect(sched(r.fx, "mid_check")[0]!.runAt).toEqual(at(54));
    expect(sched(r.fx, "risk_tick")[0]!.runAt).toEqual(at(1));
    expect(sends(r.fx)).toEqual([]);
  });

  it("ARMED + start also -> ACTIVE", () => {
    expect(apply(basePlan({ state: "ARMED", locationMode: "none" }), timer("start"), ctxAt(T0)).plan.state).toBe("ACTIVE");
  });

  it("no share at start -> time-only notice and the arrival line at start (4.5, 4.6)", () => {
    const r = apply(basePlan({ state: "PRE_MEETUP" }), timer("start"), ctxAt(T0));
    expect(r.plan.locationMode).toBe("none");
    expect(sends(r.fx)).toEqual(["user:loc_time_only", "user:act_arrival"]);
  });

  it("no mid-check for short dates or non-dates", () => {
    expect(sched(apply(basePlan({ state: "PRE_MEETUP", endAt: at(80) }), timer("start"), ctxAt(T0)).fx, "mid_check")).toEqual([]);
    expect(sched(apply(basePlan({ state: "PRE_MEETUP", type: "other" }), timer("start"), ctxAt(T0)).fx, "mid_check")).toEqual([]);
  });

  it("ACTIVE + arrival detected -> arrival line once", () => {
    const p = active({ arrivedAt: null, arrivalLineSent: false });
    const f1 = fixFromVenue(at(1), 10);
    const r1 = apply(p, { type: "fix", fix: f1 }, ctxAt(at(1), { fixes: [f1] }));
    expect(r1.row).toBe("fix");
    expect(sends(r1.fx)).toEqual([]);
    const f2 = fixFromVenue(at(2), 12);
    const r2 = apply(r1.plan, { type: "fix", fix: f2 }, ctxAt(at(2), { fixes: [f1] }));
    expect(sends(r2.fx)).toEqual(["user:act_arrival"]);
    expect(r2.plan.arrivedAt).toEqual(at(2));
    const f3 = fixFromVenue(at(3), 12);
    expect(sends(apply(r2.plan, { type: "fix", fix: f3 }, ctxAt(at(3), { fixes: [f1, f2] })).fx)).toEqual([]);
  });

  it("I3: a fix outside a window is ignored", () => {
    const f = fixFromVenue(at(-60), 10);
    for (const state of ["DRAFT", "ARMED", "CLOSED", "CANCELLED", "EXPIRED"] as PlanState[]) {
      const r = apply(basePlan({ state }), { type: "fix", fix: f }, ctxAt(at(-60)));
      expect(r.row).toBeNull();
      expect(r.fx).toEqual([]);
    }
  });

  it("mid_check sends a tracked How's it going once", () => {
    const r = apply(active(), timer("mid_check"), ctxAt(at(54)));
    expect(r.row).toBe("mid-check");
    expect(r.fx).toEqual([expect.objectContaining({ kind: "send", template: "act_mid_check", track: true })]);
    expect(apply(r.plan, timer("mid_check"), ctxAt(at(55))).fx).toEqual([]);
  });
});

describe("6.2 risk triggers -> CHECKING (L0)", () => {
  const inside = Array.from({ length: 31 }, (_, m) => fixFromVenue(at(m), 15));

  it("risk_tick reschedules itself and fires T-DARK as a hard L0", () => {
    const r = apply(active(), timer("risk_tick"), ctxAt(at(40), { fixes: inside }));
    expect(r.row).toBe("risk-tick");
    expect(r.plan.state).toBe("CHECKING");
    expect(r.plan.ladderClass).toBe("hard");
    expect(r.plan.ladderTrigger).toBe("T-DARK");
    expect(sends(r.fx)).toEqual(["user:lad_l0_hard"]);
    expect(sched(r.fx, "risk_tick")[0]!.runAt).toEqual(at(41));
    expect(sched(r.fx, "ladder")[0]).toMatchObject({ runAt: at(43), payload: { step: "L1" } });
  });

  it("risk_tick in a non-live state does nothing (no reschedule)", () => {
    expect(apply(escalated(), timer("risk_tick"), ctxAt(at(41))).fx).toEqual([]);
  });

  it("a fix that confirms a departure starts a soft ladder (non-date)", () => {
    const p = active({ type: "other" });
    const fixes = [...inside, fixFromVenue(at(31), 300), fixFromVenue(at(32), 400)];
    const r = apply(p, { type: "fix", fix: fixFromVenue(at(33), 500) }, ctxAt(at(33), { fixes }));
    expect(r.plan.state).toBe("CHECKING");
    expect(sends(r.fx)).toEqual(["user:lad_l0_soft"]);
    expect(r.fx[0]).toMatchObject({ kind: "cancel_jobs" });
  });

  it("one ladder per plan: a same-class trigger during CHECKING sends nothing", () => {
    const p = checking("L0", { ladderClass: "hard", ladderTrigger: "T-DEP-CAR" });
    const r = apply(p, timer("risk_tick"), ctxAt(at(41), { fixes: inside }));
    expect(sends(r.fx)).toEqual([]);
    expect(sched(r.fx, "ladder")).toEqual([]);
  });

  it("class upgrade shortens the pending timer without restarting (soft -> hard)", () => {
    const p = checking("L0");
    const r = apply(p, timer("risk_tick"), ctxAt(at(41), { fixes: inside }));
    expect(r.plan.ladderClass).toBe("hard");
    expect(r.plan.ladderStep).toBe("L0");
    expect(r.plan.ladderStartedAt).toEqual(at(30));
    expect(sends(r.fx)).toEqual([]);
    // L0 at 30; hard T1 = 3 -> due 33, already past, so it runs now.
    expect(sched(r.fx, "ladder")[0]).toMatchObject({ runAt: at(41), payload: { step: "L1", token: at(30).toISOString() } });
  });

  it("upgrade during OVERTIME moves to CHECKING and reschedules L1 as a ladder job", () => {
    const p = active({ state: "OVERTIME", ladderStep: "L0", ladderClass: "overtime", ladderTrigger: "T-OVR", ladderStartedAt: at(135), ladderStepAt: at(135) });
    const fixes = Array.from({ length: 6 }, (_, m) => fixFromVenue(at(120 + m), 15));
    const r = apply(p, timer("risk_tick"), ctxAt(at(136), { fixes }));
    expect(r.plan.state).toBe("CHECKING");
    expect(r.plan.ladderClass).toBe("hard");
    expect(r.fx).toContainEqual({ kind: "cancel_jobs", kinds: ["ladder", "overtime_timeout"] });
    expect(sched(r.fx, "ladder")[0]!.runAt).toEqual(at(138));
  });

  it("T-VENUE-CHG sends New spot once, then soft ladder after 15 min unanswered", () => {
    const bar = { lat: VENUE.lat + 0.0036, lng: VENUE.lng };
    const fixes = [...inside, ...Array.from({ length: 12 }, (_, i) => fixAt(at(35 + i), bar.lat, bar.lng))];
    const r = apply(active(), timer("risk_tick"), ctxAt(at(46), { fixes }));
    expect(sends(r.fx)).toEqual(["user:act_new_spot"]);
    expect(r.plan.state).toBe("ACTIVE");
    const job = sched(r.fx, "venue_change_timeout")[0]!;
    expect(job.runAt).toEqual(at(61));
    const again = apply(r.plan, timer("risk_tick"), ctxAt(at(47), { fixes }));
    expect(sends(again.fx)).toEqual([]);
    const t = apply(r.plan, timer("venue_change_timeout", job.payload), ctxAt(at(61), { fixes }));
    expect(t.row).toBe("venue-change-timeout");
    expect(t.plan.state).toBe("CHECKING");
    expect(t.plan.ladderTrigger).toBe("T-VENUE-CHG");
    expect(sends(t.fx)).toEqual(["user:lad_l0_soft"]);
  });

  it("arrival during a T-NOARRIVE check resolves it", () => {
    const p = checking("L0", { arrivedAt: null, ladderTrigger: "T-NOARRIVE", arrivalLineSent: false });
    const f1 = fixFromVenue(at(31), 10);
    const r = apply(p, { type: "fix", fix: fixFromVenue(at(32), 10) }, ctxAt(at(32), { fixes: [f1] }));
    expect(r.plan.state).toBe("ACTIVE");
    expect(r.plan.ladderStep).toBeNull();
    expect(r.plan.suppressedUntil["T-NOARRIVE"]).toBe(at(52).toISOString());
  });
});

describe("6.2 / 4.7 overtime and ladder steps (6.4)", () => {
  it("ACTIVE + end+grace -> OVERTIME, overtime message, reply timeout at T1", () => {
    const r = apply(active(), timer("end_grace", { endAt: at(120).toISOString() }), ctxAt(at(135)));
    expect(r.row).toBe("end-grace-overtime");
    expect(r.plan.state).toBe("OVERTIME");
    expect(r.fx).toContainEqual(expect.objectContaining({ kind: "send", template: "ot_overtime", track: true }));
    expect(sched(r.fx, "overtime_timeout")[0]!.runAt).toEqual(at(145));
  });

  it("a stale end_grace (plan was extended) is ignored", () => {
    const r = apply(active({ endAt: at(150) }), timer("end_grace", { endAt: at(120).toISOString() }), ctxAt(at(135)));
    expect(r.row).toBeNull();
    expect(r.plan.state).toBe("ACTIVE");
  });

  it("after 4 h of implicit extensions the overtime message asks to confirm (4.7)", () => {
    const r = apply(active({ totalExtensionMin: 240 }), timer("end_grace"), ctxAt(at(135)));
    expect(sends(r.fx)).toEqual(["user:ot_max_confirm"]);
  });

  it("overtime timeout -> L1 with notifyAnyway, L2 after T2", () => {
    const p = active({ state: "OVERTIME", ladderStep: "L0", ladderClass: "overtime", ladderTrigger: "T-OVR", ladderStartedAt: at(135), ladderStepAt: at(135) });
    const r = apply(p, timer("overtime_timeout", { token: at(135).toISOString() }), ctxAt(at(145)));
    expect(r.row).toBe("overtime-timeout-l1");
    expect(r.plan.state).toBe("CHECKING");
    expect(r.fx[0]).toEqual(expect.objectContaining({ kind: "send", template: "lad_l1", notifyAnyway: true, track: true }));
    expect(sched(r.fx, "ladder")[0]).toMatchObject({ runAt: at(150), payload: { step: "L2" } });
  });

  it("overtime timeout with a stale token is ignored (idempotent jobs)", () => {
    const p = active({ state: "OVERTIME", ladderStep: "L0", ladderClass: "overtime", ladderTrigger: "T-OVR", ladderStartedAt: at(135), ladderStepAt: at(135) });
    expect(apply(p, timer("overtime_timeout", { token: at(100).toISOString() }), ctxAt(at(145))).row).toBeNull();
  });

  it("L2 rings the user AND sends lad_l2_text with notifyAnyway; L3 after T3", () => {
    const r = apply(checking("L1"), timer("ladder", { step: "L2", token: at(30).toISOString() }), ctxAt(at(39)));
    expect(r.row).toBe("ladder-step");
    expect(kinds(r.fx)).toEqual(["call:user:checkin", "send:user:lad_l2_text", "schedule"]);
    expect(r.fx[1]).toMatchObject({ notifyAnyway: true, track: true });
    expect(sched(r.fx, "ladder")[0]).toMatchObject({ runAt: at(42), payload: { step: "L3" } });
  });

  it("CHECKING + timeout after L2 -> ESCALATED: guardian alert text + call + repeats", () => {
    const r = apply(checking("L2"), timer("ladder", { step: "L3", token: at(30).toISOString() }), ctxAt(at(42), { fixes: [fixFromVenue(at(40), 500)] }));
    expect(r.plan.state).toBe("ESCALATED");
    expect(r.plan.escalationReason).toEqual({ kind: "no_reply", trigger: "T-DEP-WALK", minutesSilent: 12 });
    expect(kinds(r.fx)).toEqual(["cancel_jobs", "send:guardian:gdn_alert", "call:guardian:guardian_alert", "schedule"]);
    const alert = r.fx[1] as Extract<Effect, { kind: "send" }>;
    expect(alert).toMatchObject({ critical: true, notifyAnyway: true });
    expect(alert.params).toMatchObject({ reason: "no_reply", minutesSilent: 12, lastFix: { minutesAgo: 2 }, userName: "Alex" });
    expect(sched(r.fx, "guardian_repeat")[0]!.runAt).toEqual(at(45));
    // I5 / 6.4: no user message at L3.
    expect(sends(r.fx).filter((s) => s.startsWith("user:"))).toEqual([]);
  });

  it("a ladder job for the wrong step is ignored", () => {
    expect(apply(checking("L0"), timer("ladder", { step: "L2", token: at(30).toISOString() }), ctxAt(at(39))).row).toBeNull();
  });
});

describe("6.5 replies during CHECKING / OVERTIME", () => {
  it("CHECKING + OK -> ACTIVE, tapback, ladder cleared, trigger suppressed 20 min", () => {
    const r = apply(checking("L1"), { type: "user_reply", label: "OK", messageId: "u-9" }, ctxAt(at(36)));
    expect(r.row).toBe("reply-checking");
    expect(r.plan.state).toBe("ACTIVE");
    expect(r.plan.ladderStep).toBeNull();
    expect(r.plan.suppressedUntil["T-DEP-WALK"]).toBe(at(56).toISOString());
    expect(kinds(r.fx)).toEqual(["react", "cancel_jobs"]);
    expect(r.fx[0]).toEqual({ kind: "react", messageId: "u-9", emoji: "like" });
  });

  it("CHECKING + OK past end + grace -> OVERTIME (6.2)", () => {
    const r = apply(checking("L1"), { type: "user_reply", label: "OK", messageId: "u-9" }, ctxAt(at(140)));
    expect(r.plan.state).toBe("OVERTIME");
    expect(sends(r.fx)).toEqual(["user:ot_overtime"]);
  });

  it("overtime OK extends +30 and confirms (4.7, S-04)", () => {
    const p = checking("L1", { ladderClass: "overtime", ladderTrigger: "T-OVR", ladderStartedAt: at(135) });
    const r = apply(p, { type: "user_reply", label: "OK", messageId: "u-9" }, ctxAt(at(146)));
    expect(r.plan.state).toBe("ACTIVE");
    expect(r.plan.endAt).toEqual(at(176));
    expect(r.plan.totalExtensionMin).toBe(30);
    expect(sends(r.fx)).toEqual(["user:act_extend_confirm"]);
    expect(sched(r.fx, "end_grace")[0]!.runAt).toEqual(at(191));
    expect(r.fx[0]).toMatchObject({ kind: "react" });
  });

  it("OK in OVERTIME (L0) also extends", () => {
    const p = active({ state: "OVERTIME", ladderStep: "L0", ladderClass: "overtime", ladderTrigger: "T-OVR", ladderStartedAt: at(135), ladderStepAt: at(135) });
    const r = apply(p, { type: "user_reply", label: "OK", messageId: "u-1" }, ctxAt(at(137)));
    expect(r.plan.state).toBe("ACTIVE");
    expect(r.plan.endAt).toEqual(at(167));
  });

  it("at the 4 h cap, an overtime OK closes the plan (4.7)", () => {
    const p = active({ state: "OVERTIME", totalExtensionMin: 240, ladderStep: "L0", ladderClass: "overtime", ladderTrigger: "T-OVR", ladderStartedAt: at(135), ladderStepAt: at(135) });
    const r = apply(p, { type: "user_reply", label: "OK", messageId: "u-1" }, ctxAt(at(137)));
    expect(r.plan.state).toBe("CLOSED");
    expect(sends(r.fx)).toEqual(["user:close_done_ack"]);
  });

  it("NOT_OK -> ESCALATED immediately with the exit call (S-05)", () => {
    const r = apply(checking("L1"), { type: "user_reply", label: "NOT_OK", messageId: "u-9" }, ctxAt(at(36)));
    expect(r.plan.state).toBe("ESCALATED");
    expect(r.plan.escalationReason).toEqual({ kind: "not_ok_reply" });
    expect(kinds(r.fx)).toEqual(["send:user:act_calling_you_now", "call:user:fake", "cancel_jobs", "send:guardian:gdn_alert", "call:guardian:guardian_alert", "schedule"]);
  });

  it("AMBIGUOUS -> one clarifying line, timer not restarted", () => {
    const r = apply(checking("L1"), { type: "user_reply", label: "AMBIGUOUS", messageId: "u-9" }, ctxAt(at(36)));
    expect(r.plan.state).toBe("CHECKING");
    expect(kinds(r.fx)).toEqual(["send:user:lad_clarify"]);
    expect(apply(r.plan, { type: "user_reply", label: "AMBIGUOUS", messageId: "u-10" }, ctxAt(at(37))).fx).toEqual([]);
  });

  it("tapbacks on the last check-in: like/love/laugh/emphasize = OK, dislike/question = AMBIGUOUS", () => {
    for (const emoji of ["like", "love", "laugh", "emphasize"] as const) {
      const r = apply(checking("L1"), { type: "user_reaction", emoji, targetMessageId: "chk-1" }, ctxAt(at(36)));
      expect(r.row).toBe("reaction");
      expect(r.plan.state).toBe("ACTIVE");
    }
    for (const emoji of ["dislike", "question"] as const) {
      const r = apply(checking("L1"), { type: "user_reaction", emoji, targetMessageId: "chk-1" }, ctxAt(at(36)));
      expect(r.plan.state).toBe("CHECKING");
      expect(sends(r.fx)).toEqual(["user:lad_clarify"]);
    }
  });

  it("a tapback on some other message is ignored", () => {
    expect(apply(checking("L1"), { type: "user_reaction", emoji: "like", targetMessageId: "old" }, ctxAt(at(36))).row).toBeNull();
  });
});

describe("replies in ACTIVE and ESCALATED", () => {
  it("ACTIVE + OK -> tapback only", () => {
    const r = apply(active(), { type: "user_reply", label: "OK", messageId: "u-1" }, ctxAt(at(55)));
    expect(r.row).toBe("reply-active");
    expect(kinds(r.fx)).toEqual(["react"]);
  });

  it("ACTIVE + OK answers New spot and adopts it as the venue", () => {
    const p = active({ pendingSpot: { lat: 41.92, lng: -87.7, askedAt: at(46).toISOString() } });
    const r = apply(p, { type: "user_reply", label: "OK", messageId: "u-1" }, ctxAt(at(50)));
    expect(r.plan.venueLat).toBe(41.92);
    expect(r.plan.pendingSpot).toBeNull();
    expect(r.fx).toContainEqual({ kind: "cancel_jobs", kinds: ["venue_change_timeout"] });
  });

  it("ACTIVE + NOT_OK opens a soft check with a clarifying line", () => {
    const r = apply(active(), { type: "user_reply", label: "NOT_OK", messageId: "u-1" }, ctxAt(at(55)));
    expect(r.plan.state).toBe("CHECKING");
    expect(sends(r.fx)).toEqual(["user:lad_clarify"]);
  });

  it("ESCALATED + OK (no reply) -> ACTIVE; user and guardian told (5.3)", () => {
    const r = apply(escalated(), { type: "user_reply", label: "OK", messageId: "u-1" }, ctxAt(at(50)));
    expect(r.row).toBe("reply-escalated");
    expect(r.plan.state).toBe("ACTIVE");
    expect(sends(r.fx)).toEqual(["user:lad_resolved_after_escalation", "guardian:gdn_user_ok"]);
    expect(r.fx).toContainEqual({ kind: "cancel_jobs", kinds: ["guardian_repeat", "guardian_update"] });
    expect(sched(r.fx, "end_grace")).toHaveLength(1);
    expect(sched(r.fx, "risk_tick")).toHaveLength(1);
  });

  it("ESCALATED by alert word + OK: guardian told, user gets only a tapback (6.7 step 4)", () => {
    const r = apply(escalated({ escalationReason: { kind: "alert_word" } }), { type: "user_reply", label: "OK", messageId: "u-1" }, ctxAt(at(50)));
    expect(sends(r.fx)).toEqual(["guardian:gdn_user_ok_now"]);
    expect(r.fx[1]).toMatchObject({ kind: "react" });
  });

  it("ESCALATED + AMBIGUOUS -> one discreet line", () => {
    const r = apply(escalated(), { type: "user_reply", label: "AMBIGUOUS", messageId: "u-1" }, ctxAt(at(50)));
    expect(sends(r.fx)).toEqual(["user:lad_late_reply_discreet"]);
    expect(apply(r.plan, { type: "user_reply", label: "AMBIGUOUS", messageId: "u-2" }, ctxAt(at(51))).fx).toEqual([]);
  });
});

describe("6.6 exit word", () => {
  it("any active + exit word -> same state, innocuous reply, fake call, post-exit in 10 min", () => {
    for (const state of ["PRE_MEETUP", "ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"] as PlanState[]) {
      const r = apply(active({ state }), { type: "exit_word", messageId: "u-1" }, ctxAt(at(60)));
      expect(r.row, state).toBe("exit-word");
      expect(r.plan.state).toBe(state);
      expect(sends(r.fx)).toEqual(["user:cw_exit_reply"]);
      expect(r.fx[1]).toEqual({ kind: "call", to: "user", script: "fake" });
      expect(sched(r.fx, "post_exit")[0]).toMatchObject({ runAt: at(70), payload: { exitAt: at(60).toISOString() } });
    }
  });

  it("pauses a running ladder", () => {
    const r = apply(checking("L1"), { type: "exit_word", messageId: "u-1" }, ctxAt(at(36)));
    expect(r.fx).toContainEqual({ kind: "cancel_jobs", kinds: ["ladder", "overtime_timeout"] });
  });

  it("outside a window it does nothing", () => {
    expect(apply(basePlan({ state: "ARMED" }), { type: "exit_word", messageId: "u-1" }, ctxAt(at(-60))).fx).toEqual([]);
  });

  it("post-exit: still inside the venue -> T-POST-EXIT check", () => {
    const p = active({ exitWordAt: at(60) });
    const fixes = Array.from({ length: 11 }, (_, i) => fixFromVenue(at(60 + i), 10));
    const r = apply(p, timer("post_exit", { exitAt: at(60).toISOString() }), ctxAt(at(70), { fixes }));
    expect(r.row).toBe("post-exit");
    expect(r.plan.ladderTrigger).toBe("T-POST-EXIT");
    expect(sends(r.fx)).toEqual(["user:lad_l0_post_exit"]);
  });

  it("post-exit: left the venue -> nothing", () => {
    const p = active({ exitWordAt: at(60) });
    const r = apply(p, timer("post_exit", { exitAt: at(60).toISOString() }), ctxAt(at(70), { fixes: [fixFromVenue(at(70), 800)] }));
    expect(sends(r.fx)).toEqual([]);
    expect(r.plan.state).toBe("ACTIVE");
  });

  it("post-exit: a paused ladder resolves if the user left", () => {
    const p = checking("L1", { exitWordAt: at(36) });
    const r = apply(p, timer("post_exit", { exitAt: at(36).toISOString() }), ctxAt(at(46), { fixes: [fixFromVenue(at(46), 800)] }));
    expect(r.plan.state).toBe("ACTIVE");
  });

  it("post-exit: time-only, no ladder -> nothing (no location triggers)", () => {
    const p = active({ exitWordAt: at(60), locationMode: "none", shareConfirmedAt: null });
    expect(sends(apply(p, timer("post_exit", { exitAt: at(60).toISOString() }), ctxAt(at(70))).fx)).toEqual([]);
  });

  it("a stale post_exit (another exit word since) is ignored", () => {
    const p = active({ exitWordAt: at(65) });
    expect(apply(p, timer("post_exit", { exitAt: at(60).toISOString() }), ctxAt(at(70))).row).toBeNull();
  });
});

describe("6.7 alert word and 4.6 distress", () => {
  it("alert word -> ESCALATED, innocuous reply, guardian alert critical + call, nothing else to the user (I9)", () => {
    for (const state of ["PRE_MEETUP", "ACTIVE", "OVERTIME", "CHECKING", "CLOSING"] as PlanState[]) {
      const r = apply(active({ state }), { type: "alert_word", messageId: "u-1" }, ctxAt(at(60)));
      expect(r.row).toBe("alert-word");
      expect(r.plan.state).toBe("ESCALATED");
      expect(r.plan.escalationReason).toEqual({ kind: "alert_word" });
      expect(kinds(r.fx)).toEqual(["send:user:cw_alert_reply", "cancel_jobs", "send:guardian:gdn_alert", "call:guardian:guardian_alert", "schedule"]);
      expect(r.fx[2]).toMatchObject({ critical: true, notifyAnyway: true, params: { reason: "alert_word" } });
    }
  });

  it("alert word while already escalated relays the stronger reason once", () => {
    const r = apply(escalated(), { type: "alert_word", messageId: "u-1" }, ctxAt(at(50)));
    expect(sends(r.fx)).toEqual(["user:cw_alert_reply", "guardian:gdn_alert"]);
    const again = apply(r.plan, { type: "alert_word", messageId: "u-2" }, ctxAt(at(51)));
    expect(sends(again.fx)).toEqual(["user:cw_alert_reply"]);
  });

  it("distress -> ESCALATED + Calling you now + fake call + guardian alert", () => {
    const r = apply(active(), { type: "distress", messageId: "u-1" }, ctxAt(at(60)));
    expect(r.row).toBe("distress");
    expect(kinds(r.fx)).toEqual(["send:user:act_calling_you_now", "call:user:fake", "cancel_jobs", "send:guardian:gdn_alert", "call:guardian:guardian_alert", "schedule"]);
  });

  it("no guardian reachable: escalation is recorded, nothing is sent to them", () => {
    const ctx = ctxAt(at(60), { guardian: { displayName: "Priya", linkStatus: "revoked", stopped: true } });
    const r = apply(active(), { type: "alert_word", messageId: "u-1" }, ctx);
    expect(r.plan.state).toBe("ESCALATED");
    expect(sends(r.fx)).toEqual(["user:cw_alert_reply"]);
    expect(r.fx.some((e) => e.kind === "call")).toBe(false);
  });
});

describe("4.6 commands and 4.8 closure", () => {
  it("done without a home geofence -> CLOSED now, purge in 24 h, watcher stopped", () => {
    for (const state of ["ACTIVE", "OVERTIME", "CHECKING"] as PlanState[]) {
      const r = apply(active({ state }), { type: "user_command", command: "done" }, ctxAt(at(100)));
      expect(r.row).toBe("cmd-done");
      expect(r.plan.state).toBe("CLOSED");
      expect(kinds(r.fx)).toEqual(["send:user:close_done_ack", "cancel_jobs", "stop_watch", "schedule"]);
      expect(sched(r.fx, "purge")[0]!.runAt).toEqual(at(100 + 24 * 60));
    }
  });

  it("done with a home geofence -> CLOSING, closes on home arrival", () => {
    const ctx = ctxAt(at(100), { user: { displayName: "Alex", homeLat: 41.899, homeLng: -87.665, decoyCaller: "roommate" } });
    const r = apply(active(), { type: "user_command", command: "done" }, ctx);
    expect(r.plan.state).toBe("CLOSING");
    expect(sched(r.fx, "closing_timeout")[0]!.runAt).toEqual(at(190));
    const h1 = fixAt(at(120), 41.899, -87.665);
    const h2 = fixAt(at(121), 41.8991, -87.6651);
    const home = apply(r.plan, { type: "fix", fix: h2 }, { ...ctx, now: at(121), fixes: [h1] });
    expect(home.plan.state).toBe("CLOSED");
    expect(sends(home.fx)).toEqual(["user:close_glad_back"]);
  });

  it("CLOSING + 90 min -> CLOSED", () => {
    const r = apply(active({ state: "CLOSING" }), timer("closing_timeout"), ctxAt(at(190)));
    expect(r.row).toBe("closing-timeout");
    expect(r.plan.state).toBe("CLOSED");
    expect(sends(r.fx)).toEqual([]);
  });

  it("home -> CLOSED; guardian all-clear only when they were involved (4.8)", () => {
    const r = apply(active(), { type: "user_command", command: "home" }, ctxAt(at(130)));
    expect(r.row).toBe("cmd-home");
    expect(sends(r.fx)).toEqual(["user:close_glad_back"]);
    const n = apply(active({ notifyGuardianStartEnd: true }), { type: "user_command", command: "home" }, ctxAt(at(130)));
    expect(sends(n.fx)).toEqual(["user:close_glad_back", "guardian:gdn_all_clear"]);
    const e = apply(escalated(), { type: "user_command", command: "home" }, ctxAt(at(130)));
    expect(sends(e.fx)).toEqual(["user:close_glad_back", "guardian:gdn_all_clear"]);
    const c = apply(active({ state: "CLOSING", escalatedAt: at(40) }), { type: "user_command", command: "home" }, ctxAt(at(130)));
    expect(sends(c.fx)).toEqual(["user:close_glad_back", "guardian:gdn_all_clear"]);
  });

  it("extend in ACTIVE moves the end and reschedules the end timer, not counted toward the cap", () => {
    const r = apply(active(), { type: "user_command", command: "extend", minutes: 30 }, ctxAt(at(100)));
    expect(r.row).toBe("cmd-extend");
    expect(r.plan.endAt).toEqual(at(150));
    expect(r.plan.totalExtensionMin).toBe(0);
    expect(sched(r.fx, "end_grace")[0]!.runAt).toEqual(at(165));
    expect(sends(r.fx)).toEqual(["user:act_extend_confirm"]);
  });

  it("+30 in OVERTIME resolves the overtime ladder (S-02)", () => {
    const p = active({ state: "OVERTIME", ladderStep: "L0", ladderClass: "overtime", ladderTrigger: "T-OVR", ladderStartedAt: at(135), ladderStepAt: at(135) });
    const r = apply(p, { type: "user_command", command: "extend", minutes: 30 }, ctxAt(at(137)));
    expect(r.plan.state).toBe("ACTIVE");
    expect(r.plan.endAt).toEqual(at(167));
    expect(r.plan.ladderStep).toBeNull();
  });

  it("extend before the meetup just moves the end", () => {
    const r = apply(basePlan({ state: "ARMED" }), { type: "user_command", command: "extend", minutes: 60 }, ctxAt(at(-60)));
    expect(r.plan.endAt).toEqual(at(180));
    expect(sched(r.fx)).toEqual([]);
  });

  it("moving updates the venue and confirms", () => {
    const r = apply(active(), { type: "user_command", command: "moving", venueText: "Bar next door", venueLat: 41.918, venueLng: -87.707 }, ctxAt(at(70)));
    expect(r.row).toBe("cmd-moving");
    expect(r.plan).toMatchObject({ venueText: "Bar next door", venueLat: 41.918, lastResolvedAt: at(70) });
    expect(sends(r.fx)).toEqual(["user:act_venue_confirm"]);
  });

  it("any non-terminal + cancel -> CANCELLED", () => {
    for (const state of ["DRAFT", "AWAITING_GUARDIAN", "ARMED", "PRE_MEETUP", "ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"] as PlanState[]) {
      const r = apply(active({ state }), { type: "user_command", command: "cancel" }, ctxAt(at(10)));
      expect(r.row, state).toBe("cmd-cancel");
      expect(r.plan.state).toBe("CANCELLED");
      expect(sends(r.fx)[0]).toBe("user:plan_cancelled");
      expect(sched(r.fx, "purge")).toHaveLength(1);
    }
    for (const state of ["CLOSED", "CANCELLED", "EXPIRED"] as PlanState[]) {
      expect(apply(active({ state }), { type: "user_command", command: "cancel" }, ctxAt(at(10))).row).toBeNull();
    }
  });

  it("I12: CLOSED/CANCELLED + 24 h -> purge fixes", () => {
    for (const state of ["CLOSED", "CANCELLED", "EXPIRED"] as PlanState[]) {
      const r = apply(active({ state }), timer("purge"), ctxAt(at(24 * 60 + 200)));
      expect(r.row).toBe("purge");
      expect(r.plan.state).toBe(state);
      expect(r.fx).toEqual([{ kind: "purge_location" }]);
    }
  });
});

describe("5.3 / 5.4 guardian", () => {
  it("repeats the shortened alert every 3 min up to 5 times until GOT IT", () => {
    let p = escalated();
    const sent: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const r = apply(p, timer("guardian_repeat"), ctxAt(at(40 + 3 * i)));
      if (i <= 5) expect(r.row).toBe("guardian-repeat");
      sent.push(...sends(r.fx));
      expect(sched(r.fx, "guardian_repeat")).toHaveLength(i < 5 ? 1 : 0);
      p = r.plan;
    }
    expect(sent).toEqual(Array(5).fill("guardian:gdn_alert_repeat"));
  });

  it("GOT IT stops repeats and starts location updates", () => {
    const r = apply(escalated(), { type: "guardian_ack" }, ctxAt(at(44)));
    expect(r.row).toBe("guardian-ack");
    expect(r.plan.guardianAckAt).toEqual(at(44));
    expect(r.fx).toEqual([{ kind: "cancel_jobs", kinds: ["guardian_repeat"] }, expect.objectContaining({ kind: "schedule", job: expect.objectContaining({ kind: "guardian_update", runAt: at(49) }) })]);
    expect(apply(escalated({ guardianAckAt: at(44) }), timer("guardian_repeat"), ctxAt(at(46))).row).toBeNull();
  });

  it("location updates only when moved > 150 m, every 5 min, for 2 h", () => {
    const p = escalated({ guardianAckAt: at(44) });
    const r1 = apply(p, timer("guardian_update"), ctxAt(at(49), { fixes: [fixFromVenue(at(48), 500)] }));
    expect(r1.row).toBe("guardian-update");
    expect(sends(r1.fx)).toEqual(["guardian:gdn_location_update"]);
    const r2 = apply(r1.plan, timer("guardian_update"), ctxAt(at(54), { fixes: [fixFromVenue(at(53), 600)] }));
    expect(sends(r2.fx)).toEqual([]);
    expect(sched(r2.fx, "guardian_update")).toHaveLength(1);
    const r3 = apply(r2.plan, timer("guardian_update"), ctxAt(at(59), { fixes: [fixFromVenue(at(58), 900)] }));
    expect(sends(r3.fx)).toEqual(["guardian:gdn_location_update"]);
    const end = apply(r3.plan, timer("guardian_update"), ctxAt(at(160), { fixes: [fixFromVenue(at(159), 3000)] }));
    expect(sends(end.fx)).toEqual([]);
    expect(sched(end.fx)).toEqual([]);
  });

  it("where is she: latest fix during an escalation, denied otherwise (I4)", () => {
    const r = apply(escalated(), { type: "guardian_location_request" }, ctxAt(at(45), { fixes: [fixFromVenue(at(44), 300)] }));
    expect(r.row).toBe("guardian-location");
    expect(r.fx[0]).toMatchObject({ to: "guardian", template: "gdn_location_update", params: { lastFix: { minutesAgo: 1 } } });
    const d = apply(active(), { type: "guardian_location_request" }, ctxAt(at(45), { fixes: [fixFromVenue(at(44), 300)] }));
    expect(d.row).toBe("guardian-location-denied");
    expect(d.fx).toHaveLength(1);
    expect(d.fx[0]).toMatchObject({ template: "gdn_location_denied" });
    expect(JSON.stringify(d.fx)).not.toMatch(/"lat"|lastFix/);
  });

  it("call her during an escalation -> check-in call to the user", () => {
    const r = apply(escalated(), { type: "guardian_call_request" }, ctxAt(at(45)));
    expect(r.row).toBe("guardian-call-escalated");
    expect(r.fx).toEqual([{ kind: "call", to: "user", script: "checkin" }]);
  });

  it("call her outside an escalation -> guardian-requested ladder: L2 now, L3 after 3 min", () => {
    const r = apply(active(), { type: "guardian_call_request" }, ctxAt(at(45)));
    expect(r.row).toBe("guardian-call-ladder");
    expect(r.plan.state).toBe("CHECKING");
    expect(r.plan.ladderClass).toBe("guardian_requested");
    expect(kinds(r.fx)).toEqual(["cancel_jobs", "call:user:checkin", "send:user:lad_l2_text", "schedule"]);
    expect(sched(r.fx, "ladder")[0]).toMatchObject({ runAt: at(48), payload: { step: "L3" } });
  });

  it("STOP: cancels guardian jobs and tells the user (I14)", () => {
    const r = apply(escalated(), { type: "guardian_stop" }, ctxAt(at(45)));
    expect(r.row).toBe("guardian-stop");
    expect(r.fx).toEqual([{ kind: "cancel_jobs", kinds: ["guardian_repeat", "guardian_update"] }, expect.objectContaining({ to: "user", template: "usr_guardian_stopped" })]);
  });

  it("I14: after STOP nothing is ever sent to the guardian", () => {
    const ctx = ctxAt(at(45), { guardian: { displayName: "Priya", linkStatus: "revoked", stopped: true } });
    const r = apply(escalated(), timer("guardian_repeat"), ctx);
    expect(sends(r.fx)).toEqual([]);
    expect(sends(apply(active({ notifyGuardianStartEnd: true }), { type: "user_command", command: "home" }, ctx).fx)).toEqual(["user:close_glad_back"]);
  });
});

describe("I16 and I7", () => {
  it("internal error during an active plan sends a plain check-in", () => {
    for (const state of ["PRE_MEETUP", "ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"] as PlanState[]) {
      const r = apply(active({ state }), { type: "internal_error", message: "boom" }, ctxAt(at(60)));
      expect(r.row).toBe("internal-error");
      expect(sends(r.fx)).toEqual(["user:plain_checkin_error"]);
      expect(r.plan.state).toBe(state);
    }
    expect(apply(basePlan({ state: "ARMED" }), { type: "internal_error", message: "x" }, ctxAt(at(-60))).fx).toEqual([]);
  });

  it("I7: the engine is deterministic: same inputs, same outputs", () => {
    const ev: EngineEvent = { type: "user_reply", label: "OK", messageId: "u-9" };
    expect(applyEvent(checking("L1"), ev, ctxAt(at(36)))).toEqual(applyEvent(checking("L1"), ev, ctxAt(at(36))));
  });

  it("does not mutate its input plan", () => {
    const p = checking("L1");
    const copy = structuredClone(p);
    applyEvent(p, { type: "user_reply", label: "OK", messageId: "u-9" }, ctxAt(at(36)));
    expect(p).toEqual(copy);
  });

  it("unmatched events are no-ops with an ignored audit", () => {
    const r = applyEvent(basePlan({ state: "CLOSED" }), { type: "guardian_ack" }, ctxAt(at(0)));
    expect(r.effects).toEqual([{ kind: "audit", event: "ignored", data: { event: "guardian_ack", state: "CLOSED" } }]);
  });
});

describe("spec 6.2 table coverage", () => {
  const SPEC_6_2: [string, string][] = [
    ["DRAFT | all required fields + guardian accepted + user go -> ARMED", "draft-go-armed"],
    ["DRAFT | required fields + go but guardian not accepted -> AWAITING_GUARDIAN", "draft-go-awaiting"],
    ["AWAITING_GUARDIAN | guardian YES -> ARMED", "awaiting-guardian-yes"],
    ["ARMED | T-30 timer -> PRE_MEETUP", "armed-t30-premeetup"],
    ["ARMED/PRE_MEETUP | startAt timer -> ACTIVE", "start-active"],
    ["ACTIVE | arrival detected -> ACTIVE", "fix"],
    ["ACTIVE | end + grace timer -> OVERTIME", "end-grace-overtime"],
    ["ACTIVE/OVERTIME | risk trigger -> CHECKING (L0)", "risk-tick"],
    ["CHECKING | user OK reply -> ACTIVE (or OVERTIME)", "reply-checking"],
    ["CHECKING | ladder timeout after L2 -> ESCALATED", "ladder-step"],
    ["any active | alert word -> ESCALATED", "alert-word"],
    ["any active | explicit distress -> ESCALATED", "distress"],
    ["any active | exit word -> same state", "exit-word"],
    ["ACTIVE/OVERTIME/CHECKING | done -> CLOSING or CLOSED", "cmd-done"],
    ["ESCALATED | user OK reply -> ACTIVE or CLOSED", "reply-escalated"],
    ["CLOSING | home arrival or home or 90 min -> CLOSED", "closing-timeout"],
    ["any non-terminal | cancel -> CANCELLED", "cmd-cancel"],
    ["CLOSED/CANCELLED | +24 h timer -> purge", "purge"],
  ];
  it.each(SPEC_6_2)("%s is implemented by row %s", (_desc, id) => {
    expect(TRANSITIONS.some((t) => t.id === id)).toBe(true);
  });
});

afterAll(() => {
  const missing = TRANSITIONS.map((t) => t.id).filter((id) => !hit.has(id));
  if (missing.length > 0) throw new Error(`Transition rows not exercised by tests: ${missing.join(", ")}`);
});
