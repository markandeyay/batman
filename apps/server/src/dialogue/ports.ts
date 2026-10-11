// Everything the dialogue layer needs from the rest of the system, as interfaces. The main
// conversation wires real implementations (store/, plan engine, gateway Channel, Photon admin
// API); tests use dialogue/memoryRepo.ts and fakes. Keep this file minimal.
import type {
  Clock,
  DecoyCaller,
  E164,
  EngineEvent,
  Guardian,
  GuardianLinkStatus,
  JobSpec,
  Plan,
  SentRef,
  TemplateId,
  User,
} from "../contracts.js";
import type { Geocoder } from "../geo/geocode.js";
import type { LlmProvider } from "../nlu/llm.js";
import type { QuestionId } from "../notify/copy.js";
import type { TemplateParams } from "../notify/templates.js";
import type { CodeWords } from "../pipeline/codewords.js";

/** One user-guardian consent record (spec 4.3, 12 user_guardians). Not in contracts.ts yet. */
export interface GuardianLink {
  userId: string;
  guardianId: string;
  status: GuardianLinkStatus;
  /** When the user named the guardian. The 48 h opt-in expiry runs from here (spec 4.3). */
  requestedAt: Date;
  respondedAt: Date | null;
  /**
   * When gdn_optin_request was actually sent. On the shared pool Batman cannot text a guardian
   * until they text their assigned number first, so this stays null until their first inbound.
   */
  optinSentAt: Date | null;
}

/** Result of registering a guardian on the shared pool (DECISIONS.md, Photon shared pool). */
export interface GuardianRegistration {
  /** The pool number assigned to this guardian. Each person gets a different one. */
  assignedNumber: E164;
  /** sms: deep link that opens a text to assignedNumber, when Photon provides one. */
  smsLink: string | null;
}

/** Plan fields the dialogue may edit directly (never `state`; state changes go through dispatch). */
export type PlanFieldPatch = Partial<
  Pick<
    Plan,
    | "guardianId"
    | "type"
    | "startAt"
    | "endAt"
    | "graceMin"
    | "venueText"
    | "venueLat"
    | "venueLng"
    | "venuePlaceType"
    | "counterpartName"
    | "counterpartSource"
    | "transport"
    | "firstTimeInPerson"
    | "buyOrSell"
    | "privateAddress"
    | "userNervous"
    | "highVigilance"
    | "notifyGuardianStartEnd"
  >
>;

export type { PlanEditField } from "../contracts.js";

/** Edit of an armed plan (spec 4.4.6). Now a contracts.ts EngineEvent handled by the engine (H4). */
export type PlanEditedEvent = Extract<EngineEvent, { type: "plan_edited" }>;

export type DialogueEvent = EngineEvent;

/** Per-user conversational context, persisted (resumable, spec 4.2). JSON-serializable. */
export interface DialogueState {
  pending?:
    /** confirmMessageId: Batman's plan_confirm message; only a tapback on it arms (L7, I1). */
    | { kind: "go"; planId: string; confirmMessageId?: string | null }
    /** fromConfirm: asked from the plan confirmation; on yes, re-confirm only the time (4.4.6). */
    | { kind: "time_confirm"; planId: string; proposed: string; fromConfirm?: boolean }
    | { kind: "time_past"; planId: string; proposed: string; fromConfirm?: boolean }
    /** An ambiguous edit ("change it to 2"): two readings, ISO strings. */
    | { kind: "time_choice"; planId: string; options: string[]; fromConfirm: boolean }
    | { kind: "replace"; planId: string; text: string }
    | { kind: "delete" }
    | { kind: "new_guardian" }
    | { kind: "codewords" }
    | { kind: "caller" }
    | { kind: "questions"; planId: string }
    /** M7: "done" before the meetup starts; YES cancels. */
    | { kind: "cancel_confirm"; planId: string }
    /** H1: the model thought the user is moving; confirm before changing the venue. */
    | { kind: "moving_confirm"; planId: string; venueText: string }
    | null;
  intake?: {
    planId: string;
    rounds: number;
    asked: QuestionId[];
    declined: QuestionId[];
    defaultsUsed: string[];
    durationMin: number | null;
    messages: string[];
  } | null;
  /** Batman's latest plan_confirm or plan_updated message (a tapback on it means GO, L7). */
  lastConfirmMessageId?: string | null;
}

export interface DialogueRepo {
  // users
  /** Active (not deleted) user for an address. */
  getUserByAddress(address: E164): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  createUser(address: E164, now: Date): Promise<User>;
  updateUser(id: string, patch: Partial<Pick<User, "displayName" | "tz" | "onboardingStep" | "decoyCaller" | "homeLat" | "homeLng">>): Promise<void>;
  /** Store code words (spec 12: hashed plus the normalized form needed for matching; never logged). */
  setCodeWords(userId: string, codeWords: CodeWords): Promise<void>;
  getCodeWords(userId: string): Promise<CodeWords | null>;
  /** Delete the user, their plans, fixes, consent records, and dialogue state (spec 4.9). */
  deleteUserData(userId: string): Promise<void>;

  // I14: address-level stop flag for anyone (user, guardian, or both).
  setStopped(address: E164, at: Date | null): Promise<void>;
  isStopped(address: E164): Promise<boolean>;

  // guardians
  getGuardianByAddress(address: E164): Promise<Guardian | null>;
  getGuardian(id: string): Promise<Guardian | null>;
  createGuardian(address: E164, displayName: string | null, now: Date): Promise<Guardian>;
  updateGuardian(id: string, patch: Partial<Pick<Guardian, "displayName" | "stoppedAt">>): Promise<void>;

  // consent links
  getLink(userId: string, guardianId: string): Promise<GuardianLink | null>;
  listLinksForUser(userId: string): Promise<GuardianLink[]>;
  listLinksForGuardian(guardianId: string): Promise<GuardianLink[]>;
  upsertLink(link: GuardianLink): Promise<void>;

  // plans
  /** The user's latest non-terminal plan, or null. One open plan per user (spec 4.4.6). */
  getOpenPlanForUser(userId: string): Promise<Plan | null>;
  getPlan(id: string): Promise<Plan | null>;
  /** Non-terminal plans whose guardianId is this guardian (escalations, "call her"). */
  listOpenPlansForGuardian(guardianId: string): Promise<Plan[]>;
  /** New plan in DRAFT. */
  createDraftPlan(userId: string, init: PlanFieldPatch, now: Date): Promise<Plan>;
  /** Edit non-state fields. State transitions only happen through DialoguePorts.dispatch. */
  updatePlanFields(planId: string, patch: PlanFieldPatch): Promise<void>;

  // dialogue context
  getDialogueState(userId: string): Promise<DialogueState | null>;
  setDialogueState(userId: string, state: DialogueState | null): Promise<void>;
}

export interface DialogueLogger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
}

export interface DialoguePorts {
  repo: DialogueRepo;
  clock: Clock;
  /**
   * Apply an event to the plan engine and execute its effects. The engine owns the code word
   * replies (cw_exit_reply / cw_alert_reply), the exit call, distress "Calling you now.", arming
   * copy (plan_locked_in / plan_awaiting_guardian / plan_armed_now), and all ladder copy.
   */
  dispatch(planId: string, event: DialogueEvent): Promise<void>;
  /** Render (notify/templates.ts) and send. Implementations must drop sends to stopped addresses (I14). */
  sendTemplate(to: E164, template: TemplateId, params?: TemplateParams): Promise<SentRef | null>;
  /** Send copy that has no TemplateId: validated LLM copy and EXTRA_COPY lines only. */
  sendText(to: E164, text: string): Promise<SentRef | null>;
  react(messageId: string, emoji: "like"): Promise<void>;
  typing<T>(to: E164, fn: () => Promise<T>): Promise<T>;
  /** Share Batman's own contact card (onboarding, spec 4.2). */
  shareContactCard(to: E164): Promise<void>;
  /**
   * Shared pool (DECISIONS.md): register the guardian as a project user. Returns the pool number
   * assigned to them, or null if registration failed. Batman still cannot text them until they
   * text that number first.
   */
  registerGuardianAddress(address: E164): Promise<GuardianRegistration | null>;
  /**
   * im.addresses.isIMessageAvailable; null when unknown. Not used for guardians: Photon rejects
   * advanced-imessage calls to a number that has not texted Batman yet.
   */
  isIMessageAvailable(address: E164): Promise<boolean | null>;
  /** Durable job for non-plan timers (guardian opt-in expiry, spec 4.3). */
  schedule(job: JobSpec): Promise<void>;
  geocoder: Geocoder;
  /** null = no LLM configured; dialogue falls back to rules and templates. */
  llm: LlmProvider | null;
  config: {
    defaultTz: string;
    /** Quota check for new conversations (spec 8.5). Omitted = always allowed. */
    allowNewConversation?: () => Promise<boolean>;
  };
  rng?: () => number;
  log?: DialogueLogger;
}

export const DEFAULT_DECOY: DecoyCaller = "roommate";
