// Shared contracts between modules. Owned by the main conversation.
// core-engineer (plan/, scheduler/, risk/, store/, location/source+replay, util/clock, admin/)
// and conversation-engineer (dialogue/, nlu/, pipeline/codewords, notify/, geo/, util/phone)
// both build against this file. Change it only in the main conversation.
//
// Design: the plan engine is pure. It takes (plan, event, now) and returns a new plan plus a
// list of Effects. An executor (gateway layer) performs the effects through a Channel. This
// keeps escalation deterministic (I7) and makes every path testable with a fake clock.

// ---------- Primitives ----------

/** E.164 phone number, e.g. "+19195550142". Validate with util/phone.ts before constructing. */
export type E164 = string & { readonly __brand?: "E164" };

export interface Clock {
  now(): Date;
  /** Resolves after `ms` of clock time. Real clock: setTimeout. Fake clock: when advanced. */
  sleep(ms: number): Promise<void>;
}

// ---------- Domain enums (spec Sections 4, 6, 7, 12) ----------

export const PLAN_TYPES = ["date", "marketplace", "viewing", "other"] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

export const PLAN_STATES = [
  "DRAFT",
  "AWAITING_GUARDIAN",
  "ARMED",
  "PRE_MEETUP",
  "ACTIVE",
  "OVERTIME",
  "CHECKING",
  "ESCALATED",
  "CLOSING",
  "CLOSED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export const TERMINAL_STATES: readonly PlanState[] = ["CLOSED", "CANCELLED", "EXPIRED"];
/** States in which the user is "in a window" for code words and discretion (I10). */
export const WINDOW_STATES: readonly PlanState[] = ["PRE_MEETUP", "ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"];
/** States in which user-facing copy must pass the discretion filter (I10). */
export const DISCREET_STATES: readonly PlanState[] = ["ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"];

export const TRANSPORTS = ["self_drive", "rideshare", "transit", "walk", "their_car", "unknown"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const DECOY_CALLERS = ["mom", "roommate", "boss"] as const;
export type DecoyCaller = (typeof DECOY_CALLERS)[number];

export type LocationMode = "findmy" | "pin" | "none";

export const LADDER_CLASSES = ["overtime", "soft", "hard", "guardian_requested"] as const;
export type LadderClass = (typeof LADDER_CLASSES)[number];

/** Ladder step. null = no ladder running. */
export type LadderStep = "L0" | "L1" | "L2" | "L3";

export const TRIGGER_IDS = [
  "T-OVR",
  "T-DEP-WALK",
  "T-DEP-CAR",
  "T-DEP-CAR-THEIRS",
  "T-FAR",
  "T-DARK",
  "T-NOARRIVE",
  "T-MKT-LONG",
  "T-VENUE-CHG",
  "T-POST-EXIT",
] as const;
export type TriggerId = (typeof TRIGGER_IDS)[number];

export type GuardianLinkStatus = "pending" | "accepted" | "declined" | "expired" | "revoked";

// ---------- Records ----------

export interface Plan {
  id: string;
  userId: string;
  guardianId: string | null;
  state: PlanState;
  type: PlanType | null;
  startAt: Date | null;
  endAt: Date | null;
  graceMin: number;
  venueText: string | null;
  venueLat: number | null;
  venueLng: number | null;
  venuePlaceType: string | null;
  counterpartName: string | null;
  counterpartSource: string | null;
  transport: Transport | null;
  firstTimeInPerson: boolean | null;
  buyOrSell: "buy" | "sell" | null;
  privateAddress: boolean | null;
  userNervous: boolean;
  highVigilance: boolean;
  notifyGuardianStartEnd: boolean;
  locationMode: LocationMode;
  ladderStep: LadderStep | null;
  ladderClass: LadderClass | null;
  ladderTrigger: TriggerId | null;
  ladderStartedAt: Date | null;
  escalatedAt: Date | null;
  escalationReason: EscalationReason | null;
  guardianAckAt: Date | null;
  arrivedAt: Date | null;
  arrivalLineSent: boolean;
  totalExtensionMin: number;
  /** Trigger ids suppressed until the given time (spec 7.3: 20 min after a user OK). */
  suppressedUntil: Partial<Record<TriggerId, string>>;
  exitWordAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type EscalationReason =
  | { kind: "no_reply"; trigger: TriggerId; minutesSilent: number }
  | { kind: "alert_word" }
  | { kind: "distress" }
  | { kind: "not_ok_reply" };

export interface User {
  id: string;
  addressE164: E164;
  displayName: string | null;
  tz: string | null;
  onboardingStep: string;
  decoyCaller: DecoyCaller;
  homeLat: number | null;
  homeLng: number | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface Guardian {
  id: string;
  addressE164: E164;
  displayName: string | null;
  createdAt: Date;
  stoppedAt: Date | null;
}

/** One location snapshot (spec 7.1). */
export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
  at: Date;
  locationType: "live" | "shallow" | "legacy" | "unknown" | "pin" | "replay";
  expiresAt: Date | null;
  source: "findmy" | "pin" | "replay";
}

// ---------- Inbound (normalized by the gateway before dialogue sees it) ----------

export type InboundContent =
  | { kind: "text"; text: string; fromVoice?: boolean }
  | { kind: "voice_unavailable" } // voice note received but STT disabled or failed
  | { kind: "contact"; name: string | null; phones: string[] }
  | { kind: "location"; lat: number; lng: number }
  | { kind: "reaction"; emoji: ReactionEmoji; targetMessageId: string; removed: boolean }
  | { kind: "other" };

export type ReactionEmoji = "like" | "love" | "laugh" | "emphasize" | "dislike" | "question" | "other";

export interface InboundMessage {
  /** Platform message id (dedupe key). */
  id: string;
  from: E164;
  at: Date;
  content: InboundContent;
}

// ---------- Plan engine events ----------

export type JobKind =
  | "t_minus_30" // ARMED -> PRE_MEETUP, request location
  | "loc_poll" // poll for Find My acceptance (every 30 s, up to 15 min)
  | "loc_reminder"
  | "start" // -> ACTIVE
  | "mid_check" // dates, 45% of window
  | "end_grace" // -> OVERTIME
  | "overtime_timeout"
  | "ladder" // advance ladder to payload.step
  | "risk_tick" // periodic evaluation for time-based triggers (T-DARK, T-NOARRIVE, T-MKT-LONG)
  | "post_exit" // 10 min after exit word
  | "venue_change_timeout"
  | "guardian_repeat" // resend shortened alert every 3 min up to 5 times
  | "guardian_update" // location updates after GOT IT
  | "closing_timeout" // CLOSING 90 min
  | "purge" // 24 h after close (I12)
  | "draft_expire" // 12 h
  | "optin_expire" // guardian opt-in 48 h
  | "reconfirm" // day-before reconfirm for plans > 7 days out
  | "escalation_end"; // M1: 2 h after the last guardian-facing activity, close an escalation

export interface JobSpec {
  kind: JobKind;
  runAt: Date;
  planId: string | null;
  payload?: Record<string, unknown>;
}

export type ReplyLabel = "OK" | "NOT_OK" | "AMBIGUOUS";

export type UserCommand =
  | { command: "done" }
  | { command: "home" }
  | { command: "extend"; minutes: number }
  | { command: "cancel" }
  | { command: "moving"; venueText: string; venueLat: number | null; venueLng: number | null };

/** Plan fields the user can edit after arming (4.4.6). */
export type PlanEditField = "startAt" | "endAt" | "venue" | "transport" | "type" | "counterpart";

export type EngineEvent =
  | { type: "arm"; guardianAccepted: boolean }
  /**
   * Edit after arming (4.4.6, H4). The dialogue has already written the new fields; the engine
   * reschedules the timers that depend on them.
   */
  | { type: "plan_edited"; fields: PlanEditField[] }
  | { type: "guardian_accepted" }
  | { type: "timer"; job: JobKind; payload?: Record<string, unknown> }
  | { type: "fix"; fix: Fix }
  | { type: "location_shared"; expiresAt: Date | null }
  | { type: "location_not_shared" }
  /**
   * okNow: the deterministic rule matched an explicit "I'm okay now" (6.7 step 4). Only this,
   * never a classifier OK, ends an alert-word or distress escalation (C2, I7).
   */
  | { type: "user_reply"; label: ReplyLabel; messageId: string; okNow?: boolean }
  | { type: "user_reaction"; emoji: ReactionEmoji; targetMessageId: string }
  | ({ type: "user_command" } & UserCommand)
  | { type: "exit_word"; messageId: string }
  | { type: "alert_word"; messageId: string }
  | { type: "distress"; messageId: string }
  | { type: "guardian_ack" }
  | { type: "guardian_stop" }
  | { type: "guardian_call_request" }
  | { type: "guardian_location_request" }
  | { type: "internal_error"; message: string }
  /**
   * A call effect finished (H5). placed=false also covers a skipped call and the runtime's hard
   * timeout. The engine sends the fake call fallback text and keeps guardian copy honest (I11).
   */
  | { type: "call_result"; script: "fake" | "checkin" | "guardian_alert"; placed: boolean };

// ---------- Effects (performed by the executor) ----------

export type Recipient = "user" | "guardian";

export type Effect =
  | {
      kind: "send";
      to: Recipient;
      template: TemplateId;
      params?: TemplateParams;
      /** Remember the sent message id on the plan for reaction matching (check-ins). */
      track?: boolean;
      /** Call notifySilenced after sending if the recipient has Focus on (L1+, guardian alerts). */
      notifyAnyway?: boolean;
      /** Safety-critical: retry up to 10 times over 5 min (spec 8.5). */
      critical?: boolean;
    }
  | { kind: "react"; messageId: string; emoji: "like" }
  | { kind: "call"; to: Recipient; script: "fake" | "checkin" | "guardian_alert" }
  | { kind: "request_location" }
  | { kind: "start_watch" }
  | { kind: "stop_watch" }
  | { kind: "schedule"; job: JobSpec }
  | { kind: "cancel_jobs"; kinds?: JobKind[] }
  | { kind: "purge_location" }
  | { kind: "audit"; event: string; data?: Record<string, unknown> };

export interface EngineResult {
  plan: Plan;
  effects: Effect[];
}

// ---------- Templates (rendered by notify/templates.ts, fixed copy, no LLM) ----------

export const TEMPLATE_IDS = [
  // onboarding (4.2)
  "onb_hello",
  "onb_ask_name",
  "onb_ask_guardian",
  "onb_guardian_texting",
  "onb_guardian_green_bubble",
  "onb_ask_codewords",
  "onb_codewords_invalid",
  "onb_save_contact",
  "onb_disclosure_done",
  "onb_guardian_invalid",
  "onb_guardian_text_first", // shared pool: guardian must text Batman first (DECISIONS.md)
  // guardian opt-in (4.3)
  "gdn_optin_request",
  "gdn_optin_thanks",
  "gdn_optin_declined_ack",
  "usr_guardian_in",
  "usr_guardian_declined",
  "usr_guardian_expired",
  "usr_guardian_stopped",
  // intake and arming (4.4)
  "plan_confirm",
  "plan_locked_in",
  "plan_awaiting_guardian",
  "plan_armed_now",
  "plan_replace_ask",
  "plan_time_past_ask",
  "plan_time_confirm_ask",
  "plan_edit_confirm",
  "plan_cancelled",
  // pre-meetup (4.5)
  "loc_request_intro",
  "loc_reminder",
  "loc_time_only",
  "loc_extend_ask",
  "loc_pin_unsupported", // location pins arrive without coordinates (spike finding)
  // active (4.6)
  "act_arrival",
  "act_mid_check",
  "act_extend_confirm",
  "act_venue_confirm",
  "act_new_spot",
  "act_calling_you_now",
  // overtime and ladder (4.7, 6.4, 7.6)
  "ot_overtime",
  "ot_max_confirm",
  "lad_l0_soft",
  "lad_l0_hard",
  "lad_l0_noarrive",
  "lad_l0_post_exit",
  "lad_l1",
  "lad_l2_text",
  "lad_clarify",
  "lad_resolved_after_escalation",
  "lad_late_reply_discreet",
  // code words (6.6, 6.7)
  "cw_exit_reply",
  "cw_alert_reply",
  "cw_call_fallback_text",
  // closure (4.8)
  "close_glad_back",
  "close_done_ack",
  // guardian alerts and updates (5.1, 5.3, 5.4)
  "gdn_alert",
  "gdn_alert_repeat",
  "gdn_location_update",
  "gdn_user_ok",
  "gdn_user_ok_now",
  "gdn_all_clear",
  "gdn_location_denied",
  "gdn_call_unavailable",
  // misc (4.9, I14, I16)
  "help",
  "status",
  "stop_ack",
  "plain_checkin_error",
  "voice_unavailable",
  "unsupported_content",
  "delete_confirm_ask",
  "delete_done",
  "quota_onboarding_paused",
  // dialogue lines that used to be free text (EXTRA_COPY), now fixed templates (9.4)
  "intake_questions", // validated LLM-phrased intake questions (param questionsText) or their template fallback
  "ask_caller",
  "caller_set",
  "codewords_busy",
  "no_plan_distress",
  "guardian_call_outside",
  "replace_kept",
  "delete_kept",
  "ask_time_again",
  "ask_new_guardian",
  // guardian start notice for notifyGuardianStartEnd (4.4.2, 4.8)
  "gdn_plan_started",
  // M7: "done" before the meetup starts asks before cancelling
  "plan_cancel_confirm_ask",
  // X3: L3 with no reachable guardian. Discreet line in a window; plain explanation after it.
  "usr_backup_unreachable",
  "usr_backup_unreachable_explain",
  // X4: a plan that never got a guardian expired at its start
  "plan_expired_unarmed",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/**
 * Canonical template parameters (C1). The plan engine emits exactly these keys in send effects;
 * notify/templates.ts reads exactly these. Parameters a template may use. All optional; templates degrade gracefully. Dates may be Date
 * objects or ISO strings (job payloads are JSON). Passing `plan` fills plan fields automatically;
 * explicit keys override plan-derived values.
 */
export type TemplateParams = {
  plan?: Partial<Plan> | null;
  userName?: string | null;
  guardianName?: string | null;
  tz?: string | null;
  now?: Date | string;
  type?: PlanType | null;
  startAt?: Date | string | null;
  endAt?: Date | string | null;
  venueText?: string | null;
  counterpartName?: string | null;
  counterpartSource?: string | null;
  transport?: Transport | null;
  buyOrSell?: "buy" | "sell" | null;
  durationMin?: number | null;
  /** Escalation reason (gdn_alert). Defaults to plan.escalationReason. */
  reason?: EscalationReason | null;
  /** Ladder trigger for reason lines, when reason is not given. */
  trigger?: TriggerId | null;
  minutesSilent?: number | null;
  /** How many of Batman's texts went unanswered (gdn_alert honesty, I11). */
  messagesUnanswered?: number | null;
  /** Whether a check-in call was actually placed (I11: never claim a call that did not happen). */
  callPlaced?: boolean | null;
  /** Last usable fix for guardian alerts and updates. */
  fix?: { lat: number; lng: number; accuracyM: number; at: Date | string } | null;
  /** Reverse geocoded address for the fix. */
  address?: string | null;
  locationMode?: "findmy" | "pin" | "none" | null;
  /** Fields whose defaults were used ("duration", "type"). */
  defaultsUsed?: string[] | null;
  /** One safety tip line (intake only, at most one). */
  tip?: string | null;
  /** plan_locked_in / plan_awaiting_guardian: the meetup starts within 30 min. */
  soon?: boolean | null;
  /** close_done_ack: true when the plan closed right away (no home geofence). */
  closed?: boolean | null;
  /** plan_edit_confirm: human readable changes, e.g. ["starts Sat 8:00 PM"]. */
  changes?: string[] | null;
  /** onb_codewords_invalid / onb_guardian_invalid reason id. */
  reasonId?: string | null;
  /** status: plan state; null = no plan. */
  state?: PlanState | null;
  /** plan_time_past_ask / plan_time_confirm_ask: the time to propose. */
  suggestedStart?: Date | string | null;
  /** loc_extend_ask: when the current share ends. */
  expiresAt?: Date | string | null;
  /** onb_save_contact: true when the user only changed code words (no contact card step). */
  changeOnly?: boolean | null;
  /** onb_guardian_text_first: the pool number assigned to the guardian, and its sms: link. */
  assignedNumber?: string | null;
  smsLink?: string | null;
  /** intake_questions: the validated LLM-phrased question text (spec 9.4). */
  questionsText?: string | null;
  /** caller_set: the chosen decoy caller. */
  decoyCaller?: DecoyCaller | null;
  /** gdn_all_clear / close_done_ack: why the plan ended (H2: honest copy per reason). */
  closeReason?: CloseReason | null;
};

/** Why a plan closed. Only "home" and "home_arrival" may say "home safe" (I11). */
export type CloseReason =
  | "home"
  | "home_arrival"
  | "home_after_alert"
  | "done"
  | "done_after_alert"
  | "cancelled"
  | "cancelled_after_alert"
  | "timeout"
  | "max_extension"
  | "escalation_timeout"
  | "expired";

// ---------- Channel (spec 8.5: dialogue depends on this, not on iMessage) ----------

export interface SentRef {
  /** Platform message id of the sent message (target for reaction matching). */
  id: string;
  at: Date;
}

export interface Channel {
  sendText(to: E164, text: string): Promise<SentRef>;
  react(messageId: string, emoji: "like"): Promise<void>;
  /** Show the typing indicator while fn runs (space.responding). */
  typing<T>(to: E164, fn: () => Promise<T>): Promise<T>;
  /** Share Batman's own contact card (onboarding). May be a no-op on providers without it. */
  shareContactCard(to: E164): Promise<void>;
  /** Notify Anyway for a sent message if the recipient's Focus is on. No-op when unsupported. */
  notifyAnyway(to: E164, sent: SentRef): Promise<void>;
}

export interface CallService {
  /** Returns false if no call could be placed (caller then uses the text fallback). */
  place(to: E164, script: "fake" | "checkin" | "guardian_alert", ctx: { decoy: DecoyCaller; userName: string }): Promise<boolean>;
}

export interface LocationSource {
  start(userAddress: E164, onFix: (fix: Fix) => void): Promise<void>;
  stop(): Promise<void>;
}
