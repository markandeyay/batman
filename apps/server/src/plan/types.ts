// Engine-side plan record and context (spec 6, 7). Extends contracts.Plan with the bookkeeping
// fields the engine needs to stay idempotent and restart-safe. Everything here is persisted
// by store/repo.ts (spec 12 plus the columns listed in store/schema.ts).
import type { DecoyCaller, Fix, GuardianLinkStatus, Plan, PlanState } from "../contracts.js";

/** Small one-shot flags, persisted as JSON (plans.engine_state_json). */
export interface PlanFlags {
  /** loc_reminder sent (4.5 step 4, at most one). */
  locReminderSent: boolean;
  /** "No location, no problem" sent (4.5 step 4, once). */
  timeOnlyNoticeSent: boolean;
  /** Ask to extend a short share sent (4.5 step 5, once). */
  extendAskSent: boolean;
  /** lad_clarify sent during the current ladder (6.5 item 4, once per ladder). */
  clarifySent: boolean;
  /** lad_late_reply_discreet sent after L3 (6.4, once). */
  lateReplySent: boolean;
  /** Mid-meetup check already scheduled or sent (4.6). */
  midCheckSent: boolean;
  /** X3: usr_backup_unreachable sent (once per plan). */
  backupUnreachableSent: boolean;
  /** X3: the plain explanation is owed once the window is over. */
  backupUnreachableExplainPending: boolean;
}

/** A stay at a new spot awaiting the user's answer to "New spot?" (T-VENUE-CHG, 7.3). */
export interface PendingSpot {
  lat: number;
  lng: number;
  /** When "New spot?" was sent. */
  askedAt: string;
}

export interface EnginePlan extends Plan {
  /** Platform id of the last tracked check-in (target for reaction matching, 6.5 item 5). */
  lastCheckinMessageId: string | null;
  lastCheckinAt: Date | null;
  /** Shortened guardian alerts already resent (5.3, max 5). */
  guardianRepeatCount: number;
  lastGuardianUpdateAt: Date | null;
  lastGuardianUpdateLat: number | null;
  lastGuardianUpdateLng: number | null;
  /** When the current ladder step was taken (timers T1/T2/T3 count from here). */
  ladderStepAt: Date | null;
  /** Find My request sent (4.5 step 2). */
  locRequestedAt: Date | null;
  /** Share accepted (detected by get() or a first fix). */
  shareConfirmedAt: Date | null;
  shareExpiresAt: Date | null;
  /** Last time a ladder was resolved by the user; departures before this are acknowledged. */
  lastResolvedAt: Date | null;
  pendingSpot: PendingSpot | null;
  flags: PlanFlags;
  /** Ladder texts sent to the user in the current ladder (L0, L1, L2), for gdn_alert honesty (I11). */
  ladderMessages: number;
  /** Result of the latest check-in call (call_result), null when unknown (I11: never claim a call). */
  checkinCallPlaced: boolean | null;
  /** Last guardian-facing activity during an escalation (alert, repeat, update, GOT IT). Drives escalation_end (M1). */
  escalationActivityAt: Date | null;
  /** Last plain_checkin_error sent (M3: at most once per hour). */
  errorCheckinAt: Date | null;
  /** State before an escalation that started outside a window (H3: ARMED, AWAITING_GUARDIAN). */
  preEscalationState: PlanState | null;
}

export const DEFAULT_FLAGS: PlanFlags = {
  locReminderSent: false,
  timeOnlyNoticeSent: false,
  extendAskSent: false,
  clarifySent: false,
  lateReplySent: false,
  midCheckSent: false,
  backupUnreachableSent: false,
  backupUnreachableExplainPending: false,
};

/** What the engine knows about the guardian link at event time. */
export interface GuardianCtx {
  displayName: string | null;
  linkStatus: GuardianLinkStatus;
  /** Guardian texted STOP (I14). */
  stopped: boolean;
}

/** Inputs to applyEvent besides the plan and the event. Built by plan/context.ts or tests. */
export interface EngineContext {
  now: Date;
  user: {
    displayName: string | null;
    homeLat: number | null;
    homeLng: number | null;
    decoyCaller: DecoyCaller;
  };
  guardian: GuardianCtx | null;
  /** IANA timezone used for night hours and rendering. */
  timeZone: string;
  /** Override night-hours detection (22:00 to 05:00 local). Computed from now + timeZone if absent. */
  night?: boolean;
  /** This plan's recent fixes (any quality), ascending by `at`. Already filtered to the user (I2). */
  fixes: readonly Fix[];
  /** Result of a Find My visibility check, provided when handling loc_poll and t_minus_30. */
  share?: { visible: boolean; expiresAt: Date | null };
  /** Latest inbound user message id (target for the share-accepted tapback, 4.5 step 3). */
  lastUserMessageId?: string | null;
}

export function newEnginePlan(p: Plan): EnginePlan {
  return {
    ...p,
    lastCheckinMessageId: null,
    lastCheckinAt: null,
    guardianRepeatCount: 0,
    lastGuardianUpdateAt: null,
    lastGuardianUpdateLat: null,
    lastGuardianUpdateLng: null,
    ladderStepAt: null,
    locRequestedAt: null,
    shareConfirmedAt: null,
    shareExpiresAt: null,
    lastResolvedAt: null,
    pendingSpot: null,
    flags: { ...DEFAULT_FLAGS },
    ladderMessages: 0,
    checkinCallPlaced: null,
    escalationActivityAt: null,
    errorCheckinAt: null,
    preEscalationState: null,
  };
}
