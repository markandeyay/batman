// Plan engine (spec 6): a pure, table-driven state machine.
//
//   applyEvent(plan, event, ctx) => { plan, effects }
//
// No I/O, no clock reads (ctx.now), no randomness, no LLM (I7: the only NLU input is the
// precomputed ReplyLabel on user_reply). The executor performs effects in order.
//
// Template params are the canonical notify/templates.ts TemplateParams (C1): the engine emits
// exactly the keys the templates read (tz, now, type, reason as an EscalationReason, fix,
// closeReason, ...). The fix is only attached to guardian templates during an escalation (I4).
import type { CloseReason, TemplateParams } from "../contracts.js";
import {
  TERMINAL_STATES,
  WINDOW_STATES,
  type Effect,
  type EngineEvent,
  type EscalationReason,
  type JobKind,
  type LadderClass,
  type LadderStep,
  type PlanState,
  type ReactionEmoji,
  type ReplyLabel,
  type TemplateId,
  type TriggerId,
} from "../contracts.js";
import { haversineM, HOME_RADIUS_M, detectArrival, isNightHours, latestQualityFix, latestUsableFix, venueBaseRadiusM } from "../risk/geometry.js";
import { evaluateTriggers, locationLive, postExitStatus, type FiredTrigger } from "../risk/triggers.js";
import {
  DEFAULT_EXTENSION_MIN,
  MAX_IMPLICIT_EXTENSION_MIN,
  MIN_MS,
  SUPPRESS_AFTER_OK_MS,
  TRIGGER_CLASS,
  computeHighVigilance,
  isUpgrade,
  l0Template,
  ladderMultiplier,
  nextStep,
  stepDelayMs,
} from "./ladder.js";
import type { EngineContext, EnginePlan } from "./types.js";

export interface EngineOutput {
  plan: EnginePlan;
  effects: Effect[];
}

// ---------- timing constants (spec 4.5, 4.7, 5.3, 6.6, 7.3, I12) ----------

export const T_MINUS_MS = 30 * MIN_MS;
export const LOC_POLL_MS = 30_000;
export const LOC_POLL_WINDOW_MS = 15 * MIN_MS;
export const LOC_REMINDER_BEFORE_START_MS = 5 * MIN_MS;
export const SHARE_MARGIN_MS = 60 * MIN_MS;
export const RISK_TICK_MS = 60_000;
export const POST_EXIT_MS = 10 * MIN_MS;
export const VENUE_CHANGE_TIMEOUT_MS = 15 * MIN_MS;
export const GUARDIAN_REPEAT_MS = 3 * MIN_MS;
export const GUARDIAN_REPEAT_MAX = 5;
export const GUARDIAN_UPDATE_MS = 5 * MIN_MS;
export const GUARDIAN_UPDATE_MIN_MOVE_M = 150;
export const GUARDIAN_UPDATE_WINDOW_MS = 120 * MIN_MS;
export const CLOSING_TIMEOUT_MS = 90 * MIN_MS;
/** M1: an escalation closes 2 h after the last guardian-facing activity (alert, repeat, update, GOT IT). */
export const ESCALATION_END_MS = 120 * MIN_MS;
export const PURGE_AFTER_MS = 24 * 60 * MIN_MS;
export const DRAFT_TTL_MS = 12 * 60 * MIN_MS;
export const RECONFIRM_THRESHOLD_MS = 7 * 24 * 60 * MIN_MS;
export const RECONFIRM_BEFORE_MS = 24 * 60 * MIN_MS;
export const MID_CHECK_MIN_DURATION_MIN = 90;
export const MID_CHECK_FRACTION = 0.45;

/** Jobs that drive the ladder; cancelled together on resolution. */
const LADDER_JOBS: JobKind[] = ["ladder", "overtime_timeout"];
const GUARDIAN_JOBS: JobKind[] = ["guardian_repeat", "guardian_update"];

// ---------- builder ----------

class Tx {
  readonly p: EnginePlan;
  readonly fx: Effect[] = [];
  ctx: EngineContext;
  constructor(plan: EnginePlan, ctx: EngineContext) {
    this.p = structuredCloneDates(plan);
    this.ctx = ctx;
  }
  get now(): Date {
    return this.ctx.now;
  }
  at(msFromNow: number): Date {
    return new Date(this.now.getTime() + msFromNow);
  }
  setState(s: PlanState): void {
    this.p.state = s;
  }
  send(to: "user" | "guardian", template: TemplateId, params: TemplateParams = {}, opts: { track?: boolean; notifyAnyway?: boolean; critical?: boolean } = {}): void {
    if (to === "guardian" && !canMessageGuardian(this.p, this.ctx)) {
      this.audit("guardian_send_skipped", { template });
      return;
    }
    const all: TemplateParams = { ...baseParams(this.p, this.ctx), ...params };
    const e: Extract<Effect, { kind: "send" }> = { kind: "send", to, template, params: all };
    if (opts.track) e.track = true;
    if (opts.notifyAnyway) e.notifyAnyway = true;
    if (opts.critical) e.critical = true;
    this.fx.push(e);
  }
  react(messageId: string | null | undefined): void {
    if (messageId) this.fx.push({ kind: "react", messageId, emoji: "like" });
  }
  call(to: "user" | "guardian", script: "fake" | "checkin" | "guardian_alert"): void {
    if (to === "guardian" && !canMessageGuardian(this.p, this.ctx)) return;
    this.fx.push({ kind: "call", to, script });
  }
  schedule(job: JobKind, runAt: Date, payload?: Record<string, unknown>): void {
    const spec: Extract<Effect, { kind: "schedule" }>["job"] = { kind: job, runAt, planId: this.p.id };
    if (payload) spec.payload = payload;
    this.fx.push({ kind: "schedule", job: spec });
  }
  cancel(kinds?: JobKind[]): void {
    this.fx.push(kinds ? { kind: "cancel_jobs", kinds } : { kind: "cancel_jobs" });
  }
  audit(event: string, data?: Record<string, unknown>): void {
    this.fx.push(data ? { kind: "audit", event, data } : { kind: "audit", event });
  }
  emit(e: Effect): void {
    this.fx.push(e);
  }
  multiplier(): number {
    const night = this.ctx.night ?? isNightHours(this.now, this.ctx.timeZone);
    return ladderMultiplier({ night, highVigilance: this.p.highVigilance });
  }
}

function structuredCloneDates(p: EnginePlan): EnginePlan {
  return {
    ...p,
    suppressedUntil: { ...p.suppressedUntil },
    flags: { ...p.flags },
    pendingSpot: p.pendingSpot ? { ...p.pendingSpot } : null,
    escalationReason: p.escalationReason ? { ...p.escalationReason } : null,
  };
}

export function canMessageGuardian(p: EnginePlan, ctx: EngineContext): boolean {
  return !!p.guardianId && !!ctx.guardian && ctx.guardian.linkStatus === "accepted" && !ctx.guardian.stopped;
}

function baseParams(_p: EnginePlan, ctx: EngineContext): TemplateParams {
  const out: TemplateParams = { tz: ctx.timeZone, now: ctx.now };
  if (ctx.user.displayName) out.userName = ctx.user.displayName;
  if (ctx.guardian?.displayName) out.guardianName = ctx.guardian.displayName;
  return out;
}

function planParams(p: EnginePlan): TemplateParams {
  const out: TemplateParams = { locationMode: p.locationMode };
  if (p.type) out.type = p.type;
  if (p.startAt) out.startAt = p.startAt;
  if (p.endAt) out.endAt = p.endAt;
  if (p.venueText) out.venueText = p.venueText;
  if (p.counterpartName) out.counterpartName = p.counterpartName;
  if (p.counterpartSource) out.counterpartSource = p.counterpartSource;
  if (p.transport) out.transport = p.transport;
  if (p.buyOrSell) out.buyOrSell = p.buyOrSell;
  return out;
}

/** The latest fix for guardian templates (5.1): coordinates, accuracy, and time. Age is rendered from `now`. */
function fixParam(tx: Tx): NonNullable<TemplateParams["fix"]> | null {
  const f = latestQualityFix(tx.ctx.fixes);
  if (!f) return null;
  return { lat: f.lat, lng: f.lng, accuracyM: f.accuracyM, at: f.at };
}

// ---------- event keys and the transition table ----------

type EventKey =
  | Exclude<EngineEvent["type"], "timer" | "user_command">
  | `timer:${JobKind}`
  | `cmd:${Extract<EngineEvent, { type: "user_command" }>["command"]}`;

export function eventKey(e: EngineEvent): EventKey {
  if (e.type === "timer") return `timer:${e.job}`;
  if (e.type === "user_command") return `cmd:${e.command}`;
  return e.type;
}

type EventOf<K extends EventKey> = K extends `timer:${string}`
  ? Extract<EngineEvent, { type: "timer" }>
  : K extends `cmd:${infer C}`
    ? Extract<EngineEvent, { type: "user_command"; command: C }>
    : Extract<EngineEvent, { type: K }>;

export interface TransitionRow<K extends EventKey = EventKey> {
  /** Stable id used by tests ("6.2" rows and the supporting rows of 4.x, 5.x, 6.x). */
  id: string;
  spec: string;
  from: readonly PlanState[];
  on: K;
  when?: (p: EnginePlan, e: EventOf<K>, ctx: EngineContext) => boolean;
  run: (tx: Tx, e: EventOf<K>) => void;
}

function row<K extends EventKey>(r: TransitionRow<K>): TransitionRow {
  return r as unknown as TransitionRow;
}

const NON_TERMINAL: readonly PlanState[] = ["DRAFT", "AWAITING_GUARDIAN", "ARMED", "PRE_MEETUP", "ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"];
const LIVE: readonly PlanState[] = ["ACTIVE", "OVERTIME", "CHECKING"];
/** Armed but before the window (H3: code words and distress still count here). */
const PRE_WINDOW: readonly PlanState[] = ["ARMED", "AWAITING_GUARDIAN"];
/** Jobs of a plan that has not started yet; cancelled when it escalates early. */
const PRE_START_JOBS: JobKind[] = ["t_minus_30", "start", "reconfirm", "draft_expire", "loc_poll", "loc_reminder"];

function requiredFieldsPresent(p: EnginePlan): boolean {
  return !!p.type && !!p.startAt && !!p.endAt && !!p.venueText;
}

function guardianAcceptedNow(accepted: boolean, ctx: EngineContext): boolean {
  return accepted && !!ctx.guardian && ctx.guardian.linkStatus === "accepted" && !ctx.guardian.stopped;
}

function ladderToken(p: EnginePlan): string | null {
  return p.ladderStartedAt ? p.ladderStartedAt.toISOString() : null;
}

function payloadStr(e: { payload?: Record<string, unknown> }, key: string): string | undefined {
  const v = e.payload?.[key];
  return typeof v === "string" ? v : undefined;
}

export const TRANSITIONS: readonly TransitionRow[] = [
  // ----- 6.2 arming -----
  row({
    id: "draft-go-armed",
    spec: "6.2 DRAFT + go + guardian accepted -> ARMED",
    from: ["DRAFT"],
    on: "arm",
    when: (p, e, ctx) => requiredFieldsPresent(p) && guardianAcceptedNow(e.guardianAccepted, ctx),
    run: (tx) => {
      armPlan(tx);
      tx.send("user", "plan_locked_in", { ...planParams(tx.p), soon: tx.p.startAt!.getTime() - T_MINUS_MS <= tx.now.getTime() });
    },
  }),
  row({
    id: "draft-go-awaiting",
    spec: "6.2 DRAFT + go, guardian not accepted -> AWAITING_GUARDIAN",
    from: ["DRAFT"],
    on: "arm",
    when: (p) => requiredFieldsPresent(p),
    run: (tx) => {
      tx.setState("AWAITING_GUARDIAN");
      tx.send("user", "plan_awaiting_guardian", planParams(tx.p));
      // X4: a plan that never gets a guardian expires at its start (EXPIRED, 6.1) and says so.
      tx.schedule("draft_expire", awaitingExpiryAt(tx));
    },
  }),
  row({
    id: "draft-go-incomplete",
    spec: "4.4.6 arming requires type, start, end, venue",
    from: ["DRAFT"],
    on: "arm",
    run: (tx) => tx.audit("arm_rejected_incomplete"),
  }),
  row({
    id: "awaiting-guardian-yes",
    spec: "6.2 AWAITING_GUARDIAN + guardian YES -> ARMED",
    from: ["AWAITING_GUARDIAN"],
    on: "guardian_accepted",
    when: (_p, _e, ctx) => guardianAcceptedNow(true, ctx),
    run: (tx) => {
      armPlan(tx);
      tx.send("user", "plan_armed_now", planParams(tx.p));
    },
  }),
  row({
    id: "plan-edited-armed",
    spec: "H4 / 4.4.6 edit after arming: reschedule T-30, start, reconfirm; straight to PRE_MEETUP or ACTIVE when near or past",
    from: ["ARMED"],
    on: "plan_edited",
    run: (tx, e) => onPlanEditedBeforeStart(tx, e.fields),
  }),
  row({
    id: "plan-edited-premeetup",
    spec: "H4: edit in PRE_MEETUP: back to ARMED when the start moved out past T-30, else reschedule start",
    from: ["PRE_MEETUP"],
    on: "plan_edited",
    run: (tx, e) => onPlanEditedBeforeStart(tx, e.fields),
  }),
  row({
    id: "plan-edited-awaiting",
    spec: "H4 / X4: edit while awaiting the guardian moves the expiry to the new start",
    from: ["AWAITING_GUARDIAN"],
    on: "plan_edited",
    run: (tx, e) => {
      tx.cancel(["draft_expire"]);
      tx.schedule("draft_expire", awaitingExpiryAt(tx));
      tx.audit("plan_edited", { fields: e.fields });
    },
  }),
  row({
    id: "plan-edited-live",
    spec: "H4: edit during the meetup: end-related jobs follow the new end",
    from: ["ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"],
    on: "plan_edited",
    run: (tx, e) => {
      if ((e.fields.includes("endAt") || e.fields.includes("startAt")) && tx.p.state !== "CLOSING") scheduleEndGrace(tx);
      tx.audit("plan_edited", { fields: e.fields });
    },
  }),
  row({
    id: "armed-reconfirm",
    spec: "4.4.5 plans more than 7 days out are re-confirmed the day before",
    from: ["ARMED"],
    on: "timer:reconfirm",
    run: (tx) => tx.send("user", "plan_time_confirm_ask", planParams(tx.p)),
  }),

  // ----- 6.2 / 4.5 pre-meetup -----
  row({
    id: "armed-t30-premeetup",
    spec: "6.2 ARMED + T-30 -> PRE_MEETUP, send Find My request (4.5)",
    from: ["ARMED"],
    on: "timer:t_minus_30",
    run: (tx) => {
      tx.setState("PRE_MEETUP");
      requestLocation(tx);
    },
  }),
  row({
    id: "loc-poll",
    spec: "4.5 step 3 poll every 30 s up to 15 min",
    from: WINDOW_STATES,
    on: "timer:loc_poll",
    when: (p) => p.shareConfirmedAt === null && p.locRequestedAt !== null,
    run: (tx) => {
      if (tx.ctx.share?.visible) {
        shareAccepted(tx, tx.ctx.share.expiresAt);
        return;
      }
      if (tx.now.getTime() + LOC_POLL_MS <= tx.p.locRequestedAt!.getTime() + LOC_POLL_WINDOW_MS) tx.schedule("loc_poll", tx.at(LOC_POLL_MS));
      else tx.audit("loc_poll_gave_up");
    },
  }),
  row({
    id: "loc-shared",
    spec: "4.5 step 3 share accepted: tapback, start watcher (window states only, I3)",
    from: WINDOW_STATES,
    on: "location_shared",
    run: (tx, e) => {
      if (tx.p.shareConfirmedAt) {
        tx.p.shareExpiresAt = e.expiresAt;
        maybeAskExtendShare(tx);
        return;
      }
      shareAccepted(tx, e.expiresAt);
    },
  }),
  row({
    id: "loc-not-shared",
    spec: "4.5 step 4 no share -> time-only mode",
    from: [...WINDOW_STATES, "ARMED"],
    on: "location_not_shared",
    run: (tx) => switchToTimeOnly(tx),
  }),
  row({
    id: "loc-reminder",
    spec: "4.5 step 4 one reminder",
    from: ["PRE_MEETUP"],
    on: "timer:loc_reminder",
    when: (p) => p.shareConfirmedAt === null && !p.flags.locReminderSent && p.locationMode === "findmy",
    run: (tx) => {
      tx.p.flags.locReminderSent = true;
      tx.send("user", "loc_reminder");
    },
  }),

  // ----- 6.2 start -----
  row({
    id: "start-active",
    spec: "6.2 ARMED/PRE_MEETUP + startAt -> ACTIVE",
    from: ["ARMED", "PRE_MEETUP"],
    on: "timer:start",
    run: (tx) => startActive(tx),
  }),

  // ----- 6.2 / 4.6 / 7 fixes and risk ticks -----
  row({
    id: "fix",
    spec: "6.2 ACTIVE arrival; 7.3 triggers; 4.8 home arrival",
    from: WINDOW_STATES,
    on: "fix",
    run: (tx, e) => onFix(tx, e.fix),
  }),
  row({
    id: "risk-tick",
    spec: "7.3 time-based triggers (T-DARK, T-NOARRIVE, T-MKT-LONG)",
    from: LIVE,
    on: "timer:risk_tick",
    run: (tx) => {
      tx.schedule("risk_tick", tx.at(RISK_TICK_MS));
      evaluateAndHandle(tx);
    },
  }),
  row({
    id: "mid-check",
    spec: "4.6 mid-meetup check for first in-person dates >= 90 min",
    from: ["ACTIVE"],
    on: "timer:mid_check",
    when: (p) => !p.flags.midCheckSent,
    run: (tx) => {
      tx.p.flags.midCheckSent = true;
      tx.send("user", "act_mid_check", {}, { track: true });
    },
  }),
  row({
    id: "venue-change-timeout",
    spec: "7.3 T-VENUE-CHG becomes Soft if unanswered for 15 min",
    from: ["ACTIVE"],
    on: "timer:venue_change_timeout",
    when: (p, e) => p.pendingSpot !== null && payloadStr(e, "askedAt") === p.pendingSpot.askedAt,
    run: (tx) => startLadder(tx, "T-VENUE-CHG", "soft"),
  }),

  // ----- 6.2 / 4.7 overtime and the ladder -----
  row({
    id: "end-grace-overtime",
    spec: "6.2 ACTIVE + end+grace -> OVERTIME, send overtime message",
    from: ["ACTIVE"],
    on: "timer:end_grace",
    when: (p, e) => !payloadStr(e, "endAt") || payloadStr(e, "endAt") === p.endAt?.toISOString(),
    run: (tx) => enterOvertime(tx),
  }),
  row({
    id: "overtime-timeout-l1",
    spec: "4.7 no reply within the check window -> L1",
    from: ["OVERTIME", "CHECKING"],
    on: "timer:overtime_timeout",
    when: (p, e) => p.ladderStep === "L0" && payloadStr(e, "token") === ladderToken(p),
    run: (tx) => advanceLadder(tx, "L1"),
  }),
  row({
    id: "ladder-step",
    spec: "6.4 L1, L2; 6.2 CHECKING + ladder timeout after L2 -> ESCALATED",
    from: ["OVERTIME", "CHECKING"],
    on: "timer:ladder",
    when: (p, e) => {
      const step = payloadStr(e, "step") as LadderStep | undefined;
      return !!step && payloadStr(e, "token") === ladderToken(p) && nextStep(p.ladderStep) === step;
    },
    run: (tx, e) => advanceLadder(tx, payloadStr(e, "step") as "L1" | "L2" | "L3"),
  }),

  // ----- 6.5 replies -----
  row({
    id: "reply-checking",
    spec: "6.2 CHECKING + OK -> ACTIVE/OVERTIME; 6.4 NOT_OK -> L3; 6.5 AMBIGUOUS -> clarify",
    from: ["OVERTIME", "CHECKING"],
    on: "user_reply",
    run: (tx, e) => onLadderReply(tx, e.label, e.messageId),
  }),
  row({
    id: "reply-active",
    spec: "4.6 mid-check reply; T-VENUE-CHG answer",
    from: ["ACTIVE"],
    on: "user_reply",
    run: (tx, e) => onActiveReply(tx, e.label, e.messageId),
  }),
  row({
    id: "reply-escalated",
    spec: "6.2 ESCALATED + user OK -> ACTIVE; 5.3 notify guardian",
    from: ["ESCALATED"],
    on: "user_reply",
    run: (tx, e) => onEscalatedReply(tx, e.label, e.messageId, e.okNow === true),
  }),
  row({
    id: "reaction",
    spec: "6.5 item 5 tapbacks on Batman's last check-in",
    from: ["ACTIVE", "OVERTIME", "CHECKING", "ESCALATED"],
    on: "user_reaction",
    when: (p, e) => !!p.lastCheckinMessageId && e.targetMessageId === p.lastCheckinMessageId,
    run: (tx, e) => {
      const label = reactionLabel(e.emoji);
      if (tx.p.state === "ACTIVE") onActiveReply(tx, label, null);
      else if (tx.p.state === "ESCALATED") onEscalatedReply(tx, label, null, false);
      else onLadderReply(tx, label, null);
    },
  }),

  // ----- 6.6 / 6.7 / 4.6 code words and distress -----
  row({
    id: "exit-word",
    spec: "6.2 any active + exit word -> same state, fake call, 10 min post-exit watch (6.6)",
    from: WINDOW_STATES,
    on: "exit_word",
    run: (tx) => {
      tx.send("user", "cw_exit_reply");
      tx.call("user", "fake");
      tx.p.exitWordAt = tx.now;
      // 6.5 item 2: the ladder pauses for the post-exit watch.
      if (tx.p.ladderStep && tx.p.state !== "ESCALATED") tx.cancel(LADDER_JOBS);
      tx.cancel(["post_exit"]);
      tx.schedule("post_exit", tx.at(POST_EXIT_MS), { exitAt: tx.now.toISOString() });
      tx.audit("exit_word");
    },
  }),
  row({
    id: "exit-word-pre-window",
    spec: "H3: exit word before T-30 still rings the phone (6.6); no post-exit watch outside a window (I3)",
    from: PRE_WINDOW,
    on: "exit_word",
    run: (tx) => {
      tx.send("user", "cw_exit_reply");
      tx.call("user", "fake");
      tx.audit("exit_word");
    },
  }),
  row({
    id: "post-exit",
    spec: "6.6 step 4 / T-POST-EXIT",
    from: ["ACTIVE", "OVERTIME", "CHECKING"],
    on: "timer:post_exit",
    when: (p, e) => !!p.exitWordAt && payloadStr(e, "exitAt") === p.exitWordAt.toISOString(),
    run: (tx) => onPostExit(tx),
  }),
  row({
    id: "alert-word",
    spec: "6.2 any active + alert word -> ESCALATED, silent (6.7)",
    from: WINDOW_STATES,
    on: "alert_word",
    run: (tx) => {
      tx.send("user", "cw_alert_reply");
      escalate(tx, { kind: "alert_word" });
    },
  }),
  row({
    id: "alert-word-pre-window",
    spec: "H3 (I8, I16): alert word before T-30 escalates when a guardian has accepted (6.7)",
    from: PRE_WINDOW,
    on: "alert_word",
    when: (p, _e, ctx) => canMessageGuardian(p, ctx),
    run: (tx) => {
      tx.send("user", "cw_alert_reply");
      escalate(tx, { kind: "alert_word" });
    },
  }),
  row({
    id: "alert-word-no-guardian",
    spec: "H3: alert word before T-30 with no accepted guardian: innocuous reply only (I9)",
    from: PRE_WINDOW,
    on: "alert_word",
    run: (tx) => {
      tx.send("user", "cw_alert_reply");
      tx.audit("alert_word_no_guardian");
    },
  }),
  row({
    id: "distress",
    spec: "6.2 any active + explicit distress -> ESCALATED + exit call (4.6)",
    from: WINDOW_STATES,
    on: "distress",
    run: (tx) => {
      tx.send("user", "act_calling_you_now");
      tx.call("user", "fake");
      escalate(tx, { kind: "distress" });
    },
  }),
  row({
    id: "distress-pre-window",
    spec: "H3: explicit distress before T-30 escalates when a guardian has accepted (4.6)",
    from: PRE_WINDOW,
    on: "distress",
    when: (p, _e, ctx) => canMessageGuardian(p, ctx),
    run: (tx) => {
      tx.send("user", "act_calling_you_now");
      tx.call("user", "fake");
      escalate(tx, { kind: "distress" });
    },
  }),
  row({
    id: "distress-no-guardian",
    spec: "H3: explicit distress before T-30 with no accepted guardian: point to 911 (no_plan_distress, I6)",
    from: PRE_WINDOW,
    on: "distress",
    run: (tx) => {
      tx.send("user", "no_plan_distress");
      tx.audit("distress_no_guardian");
    },
  }),

  // ----- 4.6 user commands -----
  row({
    id: "cmd-done",
    spec: "6.2 ACTIVE/OVERTIME/CHECKING + done -> CLOSING or CLOSED",
    from: ["ACTIVE", "OVERTIME", "CHECKING", "ESCALATED"],
    on: "cmd:done",
    run: (tx) => onDone(tx),
  }),
  row({
    id: "cmd-home",
    spec: "4.6 home -> CLOSED; 6.2 CLOSING + home -> CLOSED",
    from: ["ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"],
    on: "cmd:home",
    run: (tx) => {
      const wasEscalated = tx.p.state === "ESCALATED";
      tx.send("user", "close_glad_back");
      closePlan(tx, "CLOSED", wasEscalated ? "home_after_alert" : "home");
    },
  }),
  row({
    id: "cmd-extend",
    spec: "4.6 / 4.7 extend planned end, confirm in one line",
    from: ["ARMED", "PRE_MEETUP", "ACTIVE", "OVERTIME", "CHECKING", "ESCALATED"],
    on: "cmd:extend",
    when: (_p, e) => Number.isFinite(e.minutes) && e.minutes > 0,
    run: (tx, e) => onExtend(tx, e.minutes),
  }),
  row({
    id: "cmd-moving",
    spec: "4.6 we're moving to [place]: update venue, confirm",
    from: ["ARMED", "PRE_MEETUP", "ACTIVE", "OVERTIME", "CHECKING"],
    on: "cmd:moving",
    run: (tx, e) => {
      if (tx.p.state === "OVERTIME" || tx.p.state === "CHECKING") resolveByReply(tx, null);
      tx.p.venueText = e.venueText;
      tx.p.venueLat = e.venueLat;
      tx.p.venueLng = e.venueLng;
      tx.p.pendingSpot = null;
      tx.p.lastResolvedAt = tx.now;
      tx.cancel(["venue_change_timeout"]);
      tx.send("user", "act_venue_confirm", { venueText: e.venueText });
    },
  }),
  row({
    id: "cmd-cancel",
    spec: "6.2 any non-terminal + cancel -> CANCELLED",
    from: NON_TERMINAL,
    on: "cmd:cancel",
    run: (tx) => {
      const wasEscalated = tx.p.state === "ESCALATED";
      tx.send("user", "plan_cancelled");
      closePlan(tx, "CANCELLED", wasEscalated ? "cancelled_after_alert" : "cancelled");
    },
  }),

  // ----- 6.2 / 4.8 closing -----
  row({
    id: "closing-timeout",
    spec: "6.2 CLOSING + 90 min -> CLOSED",
    from: ["CLOSING"],
    on: "timer:closing_timeout",
    run: (tx) => closePlan(tx, "CLOSED", "timeout"),
  }),
  row({
    id: "purge",
    spec: "6.2 CLOSED/CANCELLED + 24 h -> purge fixes (I12)",
    from: TERMINAL_STATES,
    on: "timer:purge",
    run: (tx) => {
      tx.emit({ kind: "purge_location" });
      tx.audit("purged");
    },
  }),
  row({
    id: "draft-expire",
    spec: "6.1 EXPIRED: draft older than 12 h, or never started",
    from: ["DRAFT", "AWAITING_GUARDIAN"],
    on: "timer:draft_expire",
    when: (p, _e, ctx) =>
      p.state === "DRAFT"
        ? ctx.now.getTime() >= p.createdAt.getTime() + DRAFT_TTL_MS
        : ctx.now.getTime() >= (p.startAt?.getTime() ?? p.endAt?.getTime() ?? p.createdAt.getTime() + DRAFT_TTL_MS),
    run: (tx) => {
      // X4: tell the user once that the unarmed plan expired (a DRAFT expires quietly).
      if (tx.p.state === "AWAITING_GUARDIAN") tx.send("user", "plan_expired_unarmed", planParams(tx.p));
      closePlan(tx, "EXPIRED", "expired");
    },
  }),

  // ----- 5.3 / 5.4 guardian -----
  row({
    id: "guardian-repeat",
    spec: "5.3 resend shortened alert every 3 min, up to 5 times, until GOT IT",
    from: ["ESCALATED"],
    on: "timer:guardian_repeat",
    when: (p) => p.guardianAckAt === null && p.guardianRepeatCount < GUARDIAN_REPEAT_MAX,
    run: (tx) => {
      tx.p.guardianRepeatCount += 1;
      bumpEscalation(tx);
      tx.send("guardian", "gdn_alert_repeat", alertParams(tx), { notifyAnyway: true, critical: true });
      if (tx.p.guardianRepeatCount < GUARDIAN_REPEAT_MAX) tx.schedule("guardian_repeat", tx.at(GUARDIAN_REPEAT_MS));
    },
  }),
  row({
    id: "guardian-ack",
    spec: "5.4 GOT IT: mark acknowledged, reduce cadence",
    from: ["ESCALATED"],
    on: "guardian_ack",
    when: (p) => p.guardianAckAt === null,
    run: (tx) => {
      tx.p.guardianAckAt = tx.now;
      tx.cancel(["guardian_repeat"]);
      bumpEscalation(tx);
      tx.schedule("guardian_update", tx.at(GUARDIAN_UPDATE_MS));
      tx.audit("guardian_ack");
    },
  }),
  row({
    id: "guardian-update",
    spec: "5.3 location updates after GOT IT: moved > 150 m, at most every 5 min, for 2 h",
    from: ["ESCALATED"],
    on: "timer:guardian_update",
    when: (p) => p.guardianAckAt !== null && p.escalatedAt !== null,
    run: (tx) => onGuardianUpdate(tx),
  }),
  row({
    id: "guardian-location",
    spec: "5.4 where is she: latest fix only during an escalation (I4)",
    from: ["ESCALATED"],
    on: "guardian_location_request",
    run: (tx) => {
      tx.send("guardian", "gdn_location_update", alertParams(tx));
      bumpEscalation(tx);
    },
  }),
  row({
    id: "escalation-end",
    spec: "M1 (I3, I12): 2 h with no guardian-facing activity: stop watching, close, tell the guardian honestly, purge in 24 h",
    from: ["ESCALATED"],
    on: "timer:escalation_end",
    when: (p, e) => !!p.escalationActivityAt && payloadStr(e, "at") === p.escalationActivityAt.toISOString(),
    run: (tx) => closePlan(tx, "CLOSED", "escalation_timeout"),
  }),
  row({
    id: "guardian-location-denied",
    spec: "5.4 location outside an escalation: I only share location during an alert",
    from: [...NON_TERMINAL.filter((s) => s !== "ESCALATED"), ...TERMINAL_STATES],
    on: "guardian_location_request",
    run: (tx) => tx.send("guardian", "gdn_location_denied"),
  }),
  row({
    id: "guardian-call-escalated",
    spec: "5.4 call her: check-in call to the user",
    from: ["ESCALATED"],
    on: "guardian_call_request",
    run: (tx) => tx.call("user", "checkin"),
  }),
  row({
    id: "guardian-call-ladder",
    spec: "6.4 guardian-requested check: L2 immediately, L3 after T3",
    from: ["ACTIVE", "OVERTIME", "CHECKING"],
    on: "guardian_call_request",
    run: (tx) => onGuardianCallRequest(tx),
  }),
  row({
    id: "guardian-stop",
    spec: "5.4 STOP: stop guardian messages, tell the user (I14)",
    from: NON_TERMINAL,
    on: "guardian_stop",
    run: (tx) => {
      tx.cancel(GUARDIAN_JOBS);
      // M7: the dialogue asks for a replacement; the copy is discreet inside a window (I10).
      tx.send("user", "usr_guardian_stopped", { state: tx.p.state });
      tx.audit(tx.p.state === "ESCALATED" ? "escalation_guardian_lost" : "guardian_stopped");
    },
  }),

  // ----- H5 call results -----
  row({
    id: "call-result",
    spec: "H5 / 6.6 step 3: a fake call that was not placed falls back to a text; I11: remember whether the check-in call happened",
    from: NON_TERMINAL,
    on: "call_result",
    run: (tx, e) => {
      tx.audit("call_result", { script: e.script, placed: e.placed });
      if (e.script === "checkin") tx.p.checkinCallPlaced = e.placed;
      if (e.script === "fake" && !e.placed) {
        tx.audit("call_fallback", { script: e.script });
        tx.send("user", "cw_call_fallback_text", {}, { notifyAnyway: true, critical: true });
      }
    },
  }),

  // ----- I16 -----
  row({
    id: "internal-error",
    spec: "I16 internal error during an active plan -> plain check-in",
    from: WINDOW_STATES,
    on: "internal_error",
    run: (tx, e) => {
      tx.send("user", "plain_checkin_error");
      tx.audit("internal_error", { message: e.message.slice(0, 200) });
    },
  }),
];

// ---------- entry point ----------

/**
 * Apply one event. Returns the next plan and the ordered effects. Unmatched (state, event)
 * pairs are no-ops with a single "ignored" audit effect.
 */
export function applyEvent(plan: EnginePlan, event: EngineEvent, ctx: EngineContext): EngineOutput {
  const key = eventKey(event);
  const tx = new Tx(plan, ctx);
  const r = TRANSITIONS.find((t) => t.on === key && t.from.includes(plan.state) && (!t.when || t.when(plan, event as never, ctx)));
  if (!r) {
    tx.audit("ignored", { event: key, state: plan.state });
    return { plan: tx.p, effects: tx.fx };
  }
  r.run(tx, event as never);
  if (tx.p.state !== plan.state) tx.audit("state", { from: plan.state, to: tx.p.state, row: r.id });
  tx.p.updatedAt = ctx.now;
  return { plan: tx.p, effects: tx.fx };
}

/** Which row would handle this event (for tests and logs). */
export function matchRow(plan: EnginePlan, event: EngineEvent, ctx: EngineContext): string | null {
  const key = eventKey(event);
  const r = TRANSITIONS.find((t) => t.on === key && t.from.includes(plan.state) && (!t.when || t.when(plan, event as never, ctx)));
  return r?.id ?? null;
}

// ---------- arming and pre-meetup ----------

function armPlan(tx: Tx): void {
  const p = tx.p;
  tx.setState("ARMED");
  p.highVigilance = computeHighVigilance(p);
  tx.cancel(["draft_expire"]);
  const start = p.startAt!.getTime();
  const now = tx.now.getTime();
  tx.schedule("t_minus_30", new Date(Math.max(now, start - T_MINUS_MS)));
  tx.schedule("start", new Date(Math.max(now, start)));
  if (start - now > RECONFIRM_THRESHOLD_MS) tx.schedule("reconfirm", new Date(start - RECONFIRM_BEFORE_MS));
}

/** X4: an AWAITING_GUARDIAN plan expires at its start (or end, or 12 h for an undated plan). */
function awaitingExpiryAt(tx: Tx): Date {
  const p = tx.p;
  const t = p.startAt ?? p.endAt;
  return t ? new Date(Math.max(tx.now.getTime(), t.getTime())) : tx.at(DRAFT_TTL_MS);
}

/**
 * H4: the start (or end) of an armed plan changed. Reschedule like armPlan, and move straight to
 * PRE_MEETUP or ACTIVE when the new start is within 30 min or past. PRE_MEETUP whose start moved
 * out past T-30 goes back to ARMED and stops the location request (I3).
 */
function onPlanEditedBeforeStart(tx: Tx, fields: readonly string[]): void {
  const p = tx.p;
  tx.audit("plan_edited", { fields: [...fields] });
  if (!p.startAt) return;
  const now = tx.now.getTime();
  const start = p.startAt.getTime();
  tx.cancel(["t_minus_30", "start", "reconfirm"]);
  if (start - T_MINUS_MS > now) {
    if (p.state === "PRE_MEETUP") {
      tx.cancel(["loc_poll", "loc_reminder"]);
      tx.emit({ kind: "stop_watch" });
      p.locRequestedAt = null;
      p.shareConfirmedAt = null;
      p.flags.locReminderSent = false;
    }
    armPlan(tx);
    return;
  }
  if (p.state === "ARMED" && start > now) {
    tx.setState("PRE_MEETUP");
    requestLocation(tx);
  }
  if (start <= now) {
    startActive(tx);
    return;
  }
  tx.schedule("start", p.startAt);
}

function requestLocation(tx: Tx): void {
  const p = tx.p;
  if (p.locationMode !== "findmy") return;
  const share = tx.ctx.share;
  const neededUntil = (p.endAt?.getTime() ?? tx.now.getTime()) + SHARE_MARGIN_MS;
  if (share?.visible && (!share.expiresAt || share.expiresAt.getTime() >= neededUntil)) {
    // 4.5 step 1: already visible long enough, skip the request.
    p.shareConfirmedAt = tx.now;
    p.shareExpiresAt = share.expiresAt;
    tx.emit({ kind: "start_watch" });
    tx.audit("share_already_visible");
    return;
  }
  tx.send("user", "loc_request_intro");
  tx.emit({ kind: "request_location" });
  p.locRequestedAt = tx.now;
  tx.schedule("loc_poll", tx.at(LOC_POLL_MS));
  const reminderAt = Math.min(tx.now.getTime() + LOC_POLL_WINDOW_MS, (p.startAt?.getTime() ?? Infinity) - LOC_REMINDER_BEFORE_START_MS);
  if (reminderAt > tx.now.getTime()) tx.schedule("loc_reminder", new Date(reminderAt));
}

function shareAccepted(tx: Tx, expiresAt: Date | null): void {
  const p = tx.p;
  p.shareConfirmedAt = tx.now;
  p.shareExpiresAt = expiresAt;
  if (p.locationMode !== "findmy") {
    p.locationMode = "findmy";
    tx.audit("time_only_ended");
  }
  tx.cancel(["loc_poll", "loc_reminder"]);
  tx.react(tx.ctx.lastUserMessageId);
  tx.emit({ kind: "start_watch" });
  maybeAskExtendShare(tx);
}

function maybeAskExtendShare(tx: Tx): void {
  const p = tx.p;
  if (p.flags.extendAskSent || !p.shareExpiresAt || !p.endAt) return;
  if (p.shareExpiresAt.getTime() < p.endAt.getTime() + SHARE_MARGIN_MS) {
    p.flags.extendAskSent = true;
    tx.send("user", "loc_extend_ask");
  }
}

function switchToTimeOnly(tx: Tx): void {
  const p = tx.p;
  if (p.shareConfirmedAt && p.locationMode === "findmy") return;
  p.locationMode = "none";
  tx.cancel(["loc_reminder"]);
  if (!p.flags.timeOnlyNoticeSent) {
    p.flags.timeOnlyNoticeSent = true;
    tx.send("user", "loc_time_only");
  }
}

function startActive(tx: Tx): void {
  const p = tx.p;
  tx.setState("ACTIVE");
  if (p.locationMode === "findmy" && !p.shareConfirmedAt) switchToTimeOnly(tx);
  scheduleEndGrace(tx);
  if (p.type === "date" && p.firstTimeInPerson !== false && p.startAt && p.endAt && !p.flags.midCheckSent) {
    const durMs = p.endAt.getTime() - p.startAt.getTime();
    if (durMs >= MID_CHECK_MIN_DURATION_MIN * MIN_MS) tx.schedule("mid_check", new Date(p.startAt.getTime() + durMs * MID_CHECK_FRACTION));
  }
  tx.schedule("risk_tick", tx.at(RISK_TICK_MS));
  // 4.6: arrival line at start in time-only mode, when arrival is already known, or when the
  // venue has no coordinates (arrival cannot be detected).
  const cannotDetect = !locationLive(p) || p.venueLat === null || p.venueLng === null;
  if (!p.arrivalLineSent && (cannotDetect || p.arrivedAt)) sendArrival(tx);
}

function scheduleEndGrace(tx: Tx): void {
  const p = tx.p;
  if (!p.endAt) return;
  tx.cancel(["end_grace"]);
  tx.schedule("end_grace", new Date(p.endAt.getTime() + p.graceMin * MIN_MS), { endAt: p.endAt.toISOString() });
}

function sendArrival(tx: Tx): void {
  tx.p.arrivalLineSent = true;
  tx.send("user", "act_arrival");
}

// ---------- fixes and triggers ----------

function fixesWith(tx: Tx, fix: EngineContextFix): EngineContextFix[] {
  const list = [...tx.ctx.fixes];
  const dup = list.some((f) => f.at.getTime() === fix.at.getTime() && f.lat === fix.lat && f.lng === fix.lng);
  if (!dup) list.push(fix);
  return list.sort((a, b) => a.at.getTime() - b.at.getTime());
}
type EngineContextFix = EngineContext["fixes"][number];

function onFix(tx: Tx, fix: EngineContextFix): void {
  const p = tx.p;
  const fixes = fixesWith(tx, fix);
  const ctx: EngineContext = { ...tx.ctx, fixes };
  tx.ctx = ctx;
  if (!p.shareConfirmedAt && fix.source !== "pin") {
    p.shareConfirmedAt = tx.now;
    if (p.locationMode !== "findmy") p.locationMode = "findmy";
    tx.cancel(["loc_poll", "loc_reminder"]);
    tx.emit({ kind: "start_watch" });
  }
  if (p.state === "CLOSING") {
    const u = ctx.user;
    if (u.homeLat !== null && u.homeLng !== null) {
      const arrived = detectArrival(fixes, { lat: u.homeLat, lng: u.homeLng }, HOME_RADIUS_M, p.closedAt ?? undefined);
      if (arrived) {
        tx.send("user", "close_glad_back");
        closePlan(tx, "CLOSED", "home_arrival");
      }
    }
    return;
  }
  if (p.state === "ESCALATED") return;
  // Arrival (7.2) from the start of the window.
  if (!p.arrivedAt && p.venueLat !== null && p.venueLng !== null) {
    const since = p.startAt ? new Date(p.startAt.getTime() - T_MINUS_MS) : undefined;
    const arrivedAt = detectArrival(fixes, { lat: p.venueLat, lng: p.venueLng }, venueBaseRadiusM(p.type), since);
    if (arrivedAt) {
      p.arrivedAt = arrivedAt;
      tx.audit("arrived");
      if (p.state === "ACTIVE" && !p.arrivalLineSent) sendArrival(tx);
      else if (p.state === "CHECKING" && p.ladderTrigger === "T-NOARRIVE") {
        // The worry was "did they make it there"; arrival answers it.
        p.arrivalLineSent = true;
        resolveLadder(tx);
        tx.setState("ACTIVE");
      }
    }
  }
  if (LIVE.includes(p.state)) evaluateAndHandle(tx);
}

function evaluateAndHandle(tx: Tx): void {
  const fired = evaluateTriggers(tx.p, tx.now, tx.ctx.fixes, { exclude: ["T-OVR"] });
  handleTriggers(tx, fired);
}

function handleTriggers(tx: Tx, fired: FiredTrigger[]): void {
  const p = tx.p;
  const ladderTrigger = fired.find((f) => f.cls !== "info" && f.id !== p.ladderTrigger);
  if (ladderTrigger && ladderTrigger.cls !== "info") {
    if (p.state === "ACTIVE") {
      startLadder(tx, ladderTrigger.id, ladderTrigger.cls);
      return;
    }
    if ((p.state === "OVERTIME" || p.state === "CHECKING") && p.ladderStep && p.ladderClass && isUpgrade(p.ladderClass, ladderTrigger.cls)) {
      upgradeLadder(tx, ladderTrigger.id, ladderTrigger.cls);
      return;
    }
  }
  const info = fired.find((f) => f.cls === "info");
  if (info && info.id === "T-VENUE-CHG" && info.spot && p.state === "ACTIVE" && !p.pendingSpot) {
    const askedAt = tx.now.toISOString();
    p.pendingSpot = { lat: info.spot.lat, lng: info.spot.lng, askedAt };
    tx.send("user", "act_new_spot", {}, { track: true });
    tx.schedule("venue_change_timeout", tx.at(VENUE_CHANGE_TIMEOUT_MS), { askedAt });
    tx.audit("trigger", { trigger: "T-VENUE-CHG" });
  }
}

// ---------- ladder ----------

function startLadder(tx: Tx, trigger: TriggerId | null, cls: LadderClass, template?: TemplateId): void {
  const p = tx.p;
  tx.setState("CHECKING");
  p.ladderStep = "L0";
  p.ladderClass = cls;
  p.ladderTrigger = trigger;
  p.ladderStartedAt = tx.now;
  p.ladderStepAt = tx.now;
  p.flags.clarifySent = false;
  p.ladderMessages = 1;
  p.checkinCallPlaced = null;
  tx.cancel(LADDER_JOBS);
  tx.send("user", template ?? l0Template(trigger, cls), {}, { track: true });
  tx.schedule("ladder", tx.at(stepDelayMs(cls, "L1", tx.multiplier())), { step: "L1", token: ladderToken(p) });
  tx.audit("trigger", { trigger, cls });
}

function enterOvertime(tx: Tx): void {
  const p = tx.p;
  tx.setState("OVERTIME");
  if (p.pendingSpot) {
    p.pendingSpot = null;
    tx.cancel(["venue_change_timeout"]);
  }
  p.ladderStep = "L0";
  p.ladderClass = "overtime";
  p.ladderTrigger = "T-OVR";
  p.ladderStartedAt = tx.now;
  p.ladderStepAt = tx.now;
  p.flags.clarifySent = false;
  p.ladderMessages = 1;
  p.checkinCallPlaced = null;
  const atCap = p.totalExtensionMin >= MAX_IMPLICIT_EXTENSION_MIN;
  tx.send("user", atCap ? "ot_max_confirm" : "ot_overtime", {}, { track: true });
  tx.schedule("overtime_timeout", tx.at(stepDelayMs("overtime", "L1", tx.multiplier())), { token: ladderToken(p) });
  tx.audit("trigger", { trigger: "T-OVR", cls: "overtime" });
}

/** A stronger trigger during a ladder: upgrade the class, shorten the pending timer, never restart (7.3). */
function upgradeLadder(tx: Tx, trigger: TriggerId, cls: LadderClass): void {
  const p = tx.p;
  const step = nextStep(p.ladderStep);
  p.ladderClass = cls;
  p.ladderTrigger = trigger;
  tx.setState("CHECKING");
  if (step === "L1" || step === "L2" || step === "L3") {
    const due = Math.max(tx.now.getTime(), (p.ladderStepAt ?? tx.now).getTime() + stepDelayMs(cls, step, tx.multiplier()));
    tx.cancel(LADDER_JOBS);
    tx.schedule("ladder", new Date(due), { step, token: ladderToken(p) });
  }
  tx.audit("ladder_upgraded", { trigger, cls });
}

function advanceLadder(tx: Tx, step: "L1" | "L2" | "L3"): void {
  const p = tx.p;
  const cls = p.ladderClass ?? "soft";
  if (step === "L3") {
    const minutesSilent = Math.max(0, Math.round((tx.now.getTime() - (p.ladderStartedAt ?? tx.now).getTime()) / MIN_MS));
    escalate(tx, { kind: "no_reply", trigger: p.ladderTrigger ?? "T-OVR", minutesSilent });
    return;
  }
  tx.setState("CHECKING");
  p.ladderStep = step;
  p.ladderStepAt = tx.now;
  p.ladderMessages += 1;
  if (step === "L1") {
    tx.send("user", "lad_l1", {}, { track: true, notifyAnyway: true });
    tx.schedule("ladder", tx.at(stepDelayMs(cls, "L2", tx.multiplier())), { step: "L2", token: ladderToken(p) });
  } else {
    // L2 rings the phone and also texts, because calls can fail on a shared pool.
    tx.call("user", "checkin");
    tx.send("user", "lad_l2_text", {}, { track: true, notifyAnyway: true });
    tx.schedule("ladder", tx.at(stepDelayMs(cls, "L3", tx.multiplier())), { step: "L3", token: ladderToken(p) });
  }
}

function clearLadder(p: EnginePlan): void {
  p.ladderStep = null;
  p.ladderClass = null;
  p.ladderTrigger = null;
  p.ladderStartedAt = null;
  p.ladderStepAt = null;
  p.flags.clarifySent = false;
  p.ladderMessages = 0;
}

/** The user answered: clear the ladder and suppress the same trigger for 20 min (7.3). */
function resolveLadder(tx: Tx): void {
  const p = tx.p;
  if (p.ladderTrigger) p.suppressedUntil[p.ladderTrigger] = tx.at(SUPPRESS_AFTER_OK_MS).toISOString();
  clearLadder(p);
  p.lastResolvedAt = tx.now;
  tx.cancel(LADDER_JOBS);
}

function escalate(tx: Tx, reason: EscalationReason): void {
  const p = tx.p;
  if (p.state === "ESCALATED") {
    // Already escalated: a stronger reason (alert word, distress) is relayed, never repeated otherwise.
    if (p.escalationReason?.kind !== reason.kind && (reason.kind === "alert_word" || reason.kind === "distress")) {
      p.escalationReason = reason;
      tx.send("guardian", "gdn_alert", alertParams(tx), { notifyAnyway: true, critical: true });
      bumpEscalation(tx);
    }
    tx.audit("escalation_reason", { reason: reason.kind });
    return;
  }
  if (PRE_WINDOW.includes(p.state)) {
    // H3: escalating before the window. Remember where we came from so a de-escalation re-arms.
    p.preEscalationState = p.state;
    tx.cancel(PRE_START_JOBS);
    if (p.locationMode === "findmy") tx.emit({ kind: "start_watch" }); // best effort: a share may already be visible
  }
  tx.setState("ESCALATED");
  p.escalatedAt = tx.now;
  p.escalationReason = reason;
  p.ladderStep = "L3";
  p.ladderStepAt = tx.now;
  p.guardianAckAt = null;
  p.guardianRepeatCount = 0;
  p.pendingSpot = null;
  tx.cancel([...LADDER_JOBS, "venue_change_timeout", "mid_check", "end_grace", "risk_tick", "post_exit"]);
  bumpEscalation(tx);
  if (!canMessageGuardian(p, tx.ctx)) {
    // M7: logged at critical level by the runtime (CRITICAL_AUDITS). X3: tell the user once with
    // discreet copy (I10); the plain explanation waits until the window is over (closePlan).
    tx.audit("escalation_no_guardian", { reason: reason.kind });
    if (!p.flags.backupUnreachableSent) {
      p.flags.backupUnreachableSent = true;
      p.flags.backupUnreachableExplainPending = true;
      tx.send("user", "usr_backup_unreachable", {}, { notifyAnyway: true });
    }
    return;
  }
  tx.send("guardian", "gdn_alert", alertParams(tx), { notifyAnyway: true, critical: true });
  tx.call("guardian", "guardian_alert");
  tx.schedule("guardian_repeat", tx.at(GUARDIAN_REPEAT_MS));
  tx.audit("escalated", { reason: reason.kind });
}

/** M1: guardian-facing activity during an escalation restarts the 2 h end timer. */
function bumpEscalation(tx: Tx): void {
  const p = tx.p;
  p.escalationActivityAt = tx.now;
  tx.cancel(["escalation_end"]);
  tx.schedule("escalation_end", tx.at(ESCALATION_END_MS), { at: tx.now.toISOString() });
}

function alertParams(tx: Tx): TemplateParams {
  const p = tx.p;
  const r = p.escalationReason;
  const out: TemplateParams = { ...planParams(p), fix: fixParam(tx) };
  if (r) {
    out.reason = { ...r };
    if (r.kind === "no_reply") {
      out.trigger = r.trigger;
      // I11: repeats and updates state the silence as of now, not as of the first alert.
      const sinceAlert = p.escalatedAt ? Math.max(0, Math.round((tx.now.getTime() - p.escalatedAt.getTime()) / MIN_MS)) : 0;
      out.minutesSilent = r.minutesSilent + sinceAlert;
      // I11: count only what was really sent, and claim a call only when call_result said so.
      if (p.ladderMessages > 0) out.messagesUnanswered = p.ladderMessages;
      out.callPlaced = p.checkinCallPlaced === true;
    }
  }
  return out;
}

// ---------- replies ----------

export function reactionLabel(emoji: ReactionEmoji): ReplyLabel {
  switch (emoji) {
    case "like":
    case "love":
    case "laugh":
    case "emphasize":
      return "OK";
    default:
      return "AMBIGUOUS";
  }
}

function onLadderReply(tx: Tx, label: ReplyLabel, messageId: string | null): void {
  const p = tx.p;
  if (label === "OK") {
    tx.react(messageId);
    resolveByReply(tx, messageId);
    return;
  }
  if (label === "NOT_OK") {
    // 6.4: jump to L3 and offer the exit call.
    tx.send("user", "act_calling_you_now");
    tx.call("user", "fake");
    escalate(tx, { kind: "not_ok_reply" });
    return;
  }
  // 6.5 item 4: one clarifying line, current step's timer keeps running.
  if (!p.flags.clarifySent) {
    p.flags.clarifySent = true;
    tx.send("user", "lad_clarify", {}, { track: true });
  } else {
    tx.audit("ambiguous_reply");
  }
}

/** Resolve the ladder after a sign of life. Overtime replies extend the plan (4.7). */
function resolveByReply(tx: Tx, _messageId: string | null): void {
  const p = tx.p;
  const wasOvertime = p.ladderClass === "overtime" || p.ladderTrigger === "T-OVR" || p.state === "OVERTIME";
  const venueAnswer = p.ladderTrigger === "T-VENUE-CHG";
  resolveLadder(tx);
  if (venueAnswer) adoptPendingSpot(tx);
  if (wasOvertime) {
    if (p.totalExtensionMin >= MAX_IMPLICIT_EXTENSION_MIN) {
      // 4.7: after 4 h of implicit extensions, close on the user's OK.
      tx.send("user", "close_done_ack", { closed: true, closeReason: "max_extension" });
      closePlan(tx, "CLOSED", "max_extension");
      return;
    }
    extendEnd(tx, DEFAULT_EXTENSION_MIN, true);
    tx.setState("ACTIVE");
    tx.send("user", "act_extend_confirm", { endAt: p.endAt });
    return;
  }
  if (p.endAt && tx.now.getTime() >= p.endAt.getTime() + p.graceMin * MIN_MS) {
    // 6.2: back to OVERTIME when past end; the overtime check starts now.
    enterOvertime(tx);
    return;
  }
  tx.setState("ACTIVE");
}

/**
 * Move the planned end. Before the end it extends from the planned end; once past it,
 * from now (so "+30" in overtime means 30 more minutes from the reply).
 */
function extendEnd(tx: Tx, minutes: number, implicit: boolean): void {
  const p = tx.p;
  if (!p.endAt) return;
  const base = Math.max(p.endAt.getTime(), tx.now.getTime());
  p.endAt = new Date(base + minutes * MIN_MS);
  if (implicit) p.totalExtensionMin += minutes;
  if (LIVE.includes(p.state) || p.state === "ESCALATED") scheduleEndGrace(tx);
}

function adoptPendingSpot(tx: Tx): void {
  const p = tx.p;
  if (!p.pendingSpot) return;
  p.venueLat = p.pendingSpot.lat;
  p.venueLng = p.pendingSpot.lng;
  p.pendingSpot = null;
  p.lastResolvedAt = tx.now;
  tx.cancel(["venue_change_timeout"]);
  tx.audit("venue_adopted");
}

function onActiveReply(tx: Tx, label: ReplyLabel, messageId: string | null): void {
  const p = tx.p;
  if (label === "OK") {
    tx.react(messageId);
    if (p.pendingSpot) adoptPendingSpot(tx);
    return;
  }
  if (label === "NOT_OK") {
    // A negative answer outside a ladder (e.g. to "How's it going?") opens a soft check.
    startLadder(tx, null, "soft", "lad_clarify");
    p.flags.clarifySent = true;
    return;
  }
  tx.audit("ambiguous_reply");
}

/** C2 (I7, 6.7 step 4): alert-word and distress escalations end only on deterministic replies. */
function silentEscalation(p: EnginePlan): boolean {
  return p.escalationReason?.kind === "alert_word" || p.escalationReason?.kind === "distress";
}

function onEscalatedReply(tx: Tx, label: ReplyLabel, messageId: string | null, okNow: boolean): void {
  const p = tx.p;
  if (silentEscalation(p) && !okNow) {
    // A classifier OK or a tapback may be coerced; only "I'm okay now", home, done, or cancel count.
    tx.audit("escalated_reply_ignored", { label });
    return;
  }
  if (label === "OK") {
    deescalate(tx, messageId);
    return;
  }
  if (label === "AMBIGUOUS" && !p.flags.lateReplySent && (p.escalationReason?.kind === "no_reply" || p.escalationReason?.kind === "not_ok_reply")) {
    p.flags.lateReplySent = true;
    tx.send("user", "lad_late_reply_discreet");
    return;
  }
  tx.audit("escalated_reply", { label });
}

/** 5.3 / 6.7 step 4: the user says they're okay during an escalation. */
function deescalate(tx: Tx, messageId: string | null): void {
  const p = tx.p;
  const silent = p.escalationReason?.kind === "alert_word" || p.escalationReason?.kind === "distress";
  tx.cancel(GUARDIAN_JOBS);
  if (silent) {
    tx.react(messageId);
    tx.send("guardian", "gdn_user_ok_now");
  } else {
    tx.send("user", "lad_resolved_after_escalation");
    tx.send("guardian", "gdn_user_ok");
  }
  clearLadder(p);
  p.lastResolvedAt = tx.now;
  resumeActive(tx);
}

/** Back to ACTIVE after an escalation: restart the end timer and risk ticks. */
function resumeActive(tx: Tx): void {
  const p = tx.p;
  const pre = p.preEscalationState;
  p.preEscalationState = null;
  if (pre && p.startAt && tx.now.getTime() < p.startAt.getTime()) {
    // H3: the escalation started before the meetup; the meetup has not started yet, so re-arm.
    tx.cancel(["risk_tick", "end_grace"]);
    tx.emit({ kind: "stop_watch" });
    armPlan(tx);
    return;
  }
  tx.setState("ACTIVE");
  if (p.endAt && tx.now.getTime() >= p.endAt.getTime() + p.graceMin * MIN_MS - MIN_MS) {
    p.endAt = new Date(tx.now.getTime() + DEFAULT_EXTENSION_MIN * MIN_MS);
  }
  scheduleEndGrace(tx);
  tx.cancel(["risk_tick"]);
  tx.schedule("risk_tick", tx.at(RISK_TICK_MS));
}

// ---------- commands ----------

function onExtend(tx: Tx, minutes: number): void {
  const p = tx.p;
  if (p.state === "ESCALATED" && silentEscalation(p)) {
    // C2: "+30" during an alert-word or distress escalation moves the end time only.
    extendEnd(tx, minutes, false);
    tx.audit("extend_during_silent_escalation");
  } else if (p.state === "ESCALATED") {
    deescalate(tx, null);
    extendEnd(tx, minutes, false);
  } else if (p.state === "OVERTIME" || p.state === "CHECKING") {
    const venueAnswer = p.ladderTrigger === "T-VENUE-CHG";
    resolveLadder(tx);
    if (venueAnswer) adoptPendingSpot(tx);
    tx.setState("ACTIVE");
    extendEnd(tx, minutes, false);
  } else {
    extendEnd(tx, minutes, false);
  }
  tx.send("user", "act_extend_confirm", { endAt: p.endAt });
}

function onDone(tx: Tx): void {
  const p = tx.p;
  const wasEscalated = p.state === "ESCALATED";
  const u = tx.ctx.user;
  if (u.homeLat !== null && u.homeLng !== null && locationLive(p)) {
    tx.cancel();
    clearLadder(p);
    p.pendingSpot = null;
    tx.setState("CLOSING");
    p.closedAt = null;
    tx.send("user", "close_done_ack", { closed: false });
    if (wasEscalated) tx.send("guardian", "gdn_user_ok_now");
    tx.schedule("closing_timeout", tx.at(CLOSING_TIMEOUT_MS));
    // Home arrival is measured from now (closedAt doubles as the CLOSING start marker).
    p.closedAt = tx.now;
    return;
  }
  tx.send("user", "close_done_ack", { closed: true });
  closePlan(tx, "CLOSED", wasEscalated ? "done_after_alert" : "done");
}

function onPostExit(tx: Tx): void {
  const p = tx.p;
  const status = postExitStatus(p, tx.now, tx.ctx.fixes);
  const paused = p.state === "OVERTIME" || p.state === "CHECKING";
  if (status === "left") {
    if (paused) {
      resolveLadder(tx);
      if (p.endAt && tx.now.getTime() >= p.endAt.getTime() + p.graceMin * MIN_MS) enterOvertime(tx);
      else tx.setState("ACTIVE");
    }
    tx.audit("post_exit_left");
    return;
  }
  // Still inside (or unknown while a ladder was paused): T-POST-EXIT check.
  if (status === "unknown" && !paused && !locationLive(p)) {
    tx.audit("post_exit_time_only");
    return;
  }
  if (p.suppressedUntil["T-POST-EXIT"] && new Date(p.suppressedUntil["T-POST-EXIT"]).getTime() > tx.now.getTime() && !paused) return;
  const cls: LadderClass = p.ladderClass && isUpgrade("soft", p.ladderClass) ? p.ladderClass : "soft";
  startLadder(tx, "T-POST-EXIT", cls);
}

function onGuardianCallRequest(tx: Tx): void {
  const p = tx.p;
  if (p.state === "CHECKING" && (p.ladderStep === "L2" || p.ladderStep === "L3")) {
    tx.call("user", "checkin");
    return;
  }
  if (p.state === "ACTIVE") {
    tx.setState("CHECKING");
    p.ladderClass = "guardian_requested";
    p.ladderTrigger = null;
    p.ladderStartedAt = tx.now;
    p.flags.clarifySent = false;
    p.ladderMessages = 0;
    p.checkinCallPlaced = null;
  } else if (p.ladderClass && isUpgrade(p.ladderClass, "guardian_requested")) {
    p.ladderClass = "guardian_requested";
  }
  tx.cancel(LADDER_JOBS);
  advanceLadder(tx, "L2");
  tx.audit("guardian_requested_check");
}

function onGuardianUpdate(tx: Tx): void {
  const p = tx.p;
  const end = p.escalatedAt!.getTime() + GUARDIAN_UPDATE_WINDOW_MS;
  if (tx.now.getTime() >= end) {
    tx.audit("guardian_updates_ended");
    return;
  }
  const f = latestUsableFix(tx.ctx.fixes, tx.now);
  if (f) {
    const moved = p.lastGuardianUpdateLat === null || p.lastGuardianUpdateLng === null || haversineM(f, { lat: p.lastGuardianUpdateLat, lng: p.lastGuardianUpdateLng }) > GUARDIAN_UPDATE_MIN_MOVE_M;
    if (moved) {
      p.lastGuardianUpdateAt = tx.now;
      p.lastGuardianUpdateLat = f.lat;
      p.lastGuardianUpdateLng = f.lng;
      tx.send("guardian", "gdn_location_update", alertParams(tx));
      bumpEscalation(tx);
    }
  }
  if (tx.now.getTime() + GUARDIAN_UPDATE_MS < end) tx.schedule("guardian_update", tx.at(GUARDIAN_UPDATE_MS));
}

// ---------- closure ----------

/**
 * Close the plan. Cancels every job, stops the watcher, schedules the 24 h purge (I12), and
 * sends the guardian all-clear only if notifyGuardianStartEnd or an escalation reached them (4.8).
 */
function closePlan(tx: Tx, to: "CLOSED" | "CANCELLED" | "EXPIRED", reason: CloseReason): void {
  const p = tx.p;
  const wasInWindow = WINDOW_STATES.includes(p.state);
  tx.cancel();
  clearLadder(p);
  p.pendingSpot = null;
  const guardianNeedsAllClear = (p.notifyGuardianStartEnd || p.escalatedAt !== null) && to !== "EXPIRED";
  tx.setState(to);
  p.closedAt = tx.now;
  if (guardianNeedsAllClear) tx.send("guardian", "gdn_all_clear", { closeReason: reason });
  if (p.flags.backupUnreachableExplainPending) {
    // X3: outside the window now, so the plain-language explanation is allowed (I10).
    p.flags.backupUnreachableExplainPending = false;
    tx.send("user", "usr_backup_unreachable_explain");
  }
  if (wasInWindow) tx.emit({ kind: "stop_watch" });
  tx.schedule("purge", tx.at(PURGE_AFTER_MS));
}

/** Plan states where a fix may be stored (I3). */
export function acceptsFixes(state: PlanState): boolean {
  return WINDOW_STATES.includes(state);
}

/** Trigger class lookup re-exported for callers. */
export { TRIGGER_CLASS };
