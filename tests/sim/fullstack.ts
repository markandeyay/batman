// Full-stack simulation harness (spec 15.1 layer 4, 15.3). Real dialogue manager (with its
// ports), real plan engine and PlanRuntime, real scheduler, real SQLite store, real templates.
// Mocked only: Photon (FakeChannel, FakeLocationSource, share probe, guardian registration),
// LiveKit (FakeCallService), and the LLM (scripted FakeLlmProvider). Time is a FakeClock.
//
// The glue in this file (Executor, dispatch adapter, quota policy, inbound dedupe) is the
// blueprint for apps/server/src/index.ts. Every place where the dialogue and engine contracts
// disagree is marked "GLUE:" and listed in the test-engineer report.
import { join } from "node:path";
import type {
  CallService,
  DecoyCaller,
  E164,
  Fix,
  InboundContent,
  LocationSource,
  PlanState,
  SentRef,
  TemplateId,
} from "../../apps/server/src/contracts.js";
import { DISCREET_STATES } from "../../apps/server/src/contracts.js";
import { handleInbound } from "../../apps/server/src/dialogue/manager.js";
import { handleOptinExpire } from "../../apps/server/src/dialogue/guardian.js";
import type { DialogueEvent, DialoguePorts, PlanEditField } from "../../apps/server/src/dialogue/ports.js";
import type { Geocoder, GeocodeResult } from "../../apps/server/src/geo/geocode.js";
import { guardedFixHandler } from "../../apps/server/src/location/source.js";
import { loadTrack, materializeTrack, type MaterializedTrack } from "../../apps/server/src/location/replay.js";
import { FakeLlmProvider, type LlmProvider } from "../../apps/server/src/nlu/llm.js";
import { renderTemplate, type TemplateParams } from "../../apps/server/src/notify/templates.js";
import { PlanRuntime, type OutboundPort, type SendEffect } from "../../apps/server/src/plan/runtime.js";
import { T_MINUS_MS } from "../../apps/server/src/plan/stateMachine.js";
import type { EnginePlan } from "../../apps/server/src/plan/types.js";
import { JobScheduler } from "../../apps/server/src/scheduler/jobs.js";
import { openStore, type Store } from "../../apps/server/src/store/db.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { FakeClock } from "../../apps/server/src/util/clock.js";
import { StoreDialogueRepo } from "./storeDialogueRepo.js";

export const START = new Date("2026-10-10T23:00:00Z"); // Sat 7:00 PM in New York
export const TZ = "America/New_York";
export const USER: E164 = "+13125550100";
export const GUARDIAN: E164 = "+19195550142";
export const GUARDIAN_POOL: E164 = "+16285550100";
export const STRANGER: E164 = "+13125550199";
export const VENUE = { lat: 41.9172, lng: -87.7067 };
const TRACKS = join(import.meta.dirname, "../fixtures/tracks");
const MIN = 60_000;

export type Role = "user" | "guardian" | "other";

export interface Sent {
  /** Minutes from START, rounded to 0.01. */
  t: number;
  at: Date;
  to: Role;
  address: E164;
  template: TemplateId | null;
  text: string;
  origin: "engine" | "dialogue";
  /** State of the user's plan when the message left (discretion checks, I10). */
  state: PlanState | null;
  critical?: boolean;
  notifyAnyway?: boolean;
  id: string;
  /** Global order of sends and calls. */
  seq: number;
}

export interface CallRec {
  t: number;
  at: Date;
  to: Role;
  address: E164;
  script: "fake" | "checkin" | "guardian_alert";
  placed: boolean;
  /** When place() resolved. */
  returnedAt: Date;
  seq: number;
}

// ---------- fakes (Photon, LiveKit, LLM) ----------

/** Fake Photon Channel: records every send, tapback, typing indicator, Notify Anyway. */
export class FakeChannel {
  private seq = 0;
  readonly reacts: { at: Date; messageId: string }[] = [];
  readonly notified: { at: Date; to: E164; messageId: string }[] = [];
  readonly cards: E164[] = [];
  constructor(private readonly clock: FakeClock) {}
  async sendText(_to: E164, _text: string): Promise<SentRef> {
    return { id: `out-${++this.seq}`, at: this.clock.now() };
  }
  async react(messageId: string): Promise<void> {
    this.reacts.push({ at: this.clock.now(), messageId });
  }
  async typing<T>(_to: E164, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async shareContactCard(to: E164): Promise<void> {
    this.cards.push(to);
  }
  async notifyAnyway(to: E164, sent: SentRef): Promise<void> {
    this.notified.push({ at: this.clock.now(), to, messageId: sent.id });
  }
}

/** Fake LiveKit CallService. `latencyMs` is fake-clock time spent inside place(). */
export class FakeCallService implements CallService {
  readonly attempts: { at: Date; to: E164; script: string; decoy: DecoyCaller }[] = [];
  constructor(
    private readonly clock: FakeClock,
    public works: boolean,
    public latencyMs = 0,
  ) {}
  async place(to: E164, script: "fake" | "checkin" | "guardian_alert", ctx: { decoy: DecoyCaller; userName: string }): Promise<boolean> {
    this.attempts.push({ at: this.clock.now(), to, script, decoy: ctx.decoy });
    if (this.latencyMs > 0) await this.clock.advance(this.latencyMs);
    return this.works;
  }
}

/** Fake Find My source. The harness pushes track fixes into the active handler. */
export class FakeLocationSource implements LocationSource {
  handler: ((fix: Fix, fromAddress?: string | null) => boolean) | null = null;
  address: E164 | null = null;
  async start(userAddress: E164, onFix: (fix: Fix) => void): Promise<void> {
    this.address = userAddress;
    this.handler = onFix as (fix: Fix, fromAddress?: string | null) => boolean;
  }
  async stop(): Promise<void> {
    this.handler = null;
  }
}

export class FixedGeocoder implements Geocoder {
  readonly name = "fixed";
  constructor(private readonly results: Record<string, GeocodeResult>) {}
  async geocode(q: string): Promise<GeocodeResult[]> {
    const hit = Object.entries(this.results).find(([k]) => q.toLowerCase().includes(k.toLowerCase()));
    return hit ? [hit[1]] : [];
  }
  async reverse(): Promise<string | null> {
    return "1820 N Milwaukee Ave, Chicago";
  }
}

export const DEFAULT_GEO: Record<string, GeocodeResult> = {
  "lula cafe": { ...VENUE, displayName: "Lula Cafe", placeType: "cafe", residential: false },
  "logan bar": { lat: 41.9208, lng: -87.7067, displayName: "Logan Bar", placeType: "bar", residential: false },
};

const EXTRACTION_BASE = {
  type: null,
  startAtText: null,
  startAtISO: null,
  venueText: null,
  durationMin: null,
  counterpartName: null,
  counterpartSource: null,
  transport: null,
  firstTimeInPerson: null,
  buyOrSell: null,
  meetingAtPrivateAddress: null,
  userNervous: false,
  wantsToChange: [],
  confidence: 0.95,
};

export interface LlmScript {
  /** Every call throws (API down). */
  down?: boolean;
  /** Extraction by substring of the newest message. */
  extract?: { match: string; out: Record<string, unknown> }[];
  /** Classification by substring of the reply. Unmatched replies throw (rule fallback). */
  classify?: { match: string; label: "OK" | "NOT_OK" | "AMBIGUOUS" | "COMMAND"; confidence?: number; command?: string; extendMin?: number }[];
}

/** The standard first-date extraction ("first date with Jordan from Hinge at 7 at Lula Cafe..."). */
export const DATE_EXTRACTION = {
  type: "date",
  startAtText: "at 7",
  startAtISO: START.toISOString(),
  venueText: "Lula Cafe",
  counterpartName: "Jordan",
  counterpartSource: "Hinge",
  transport: "self_drive",
  firstTimeInPerson: false,
  durationMin: 120,
};
export const DATE_TEXT = "date with Jordan from hinge at 7 at Lula Cafe, not our first time, driving myself, 2 hours";

export function scriptedLlm(s: LlmScript): FakeLlmProvider {
  return new FakeLlmProvider((req) => {
    if (s.down) throw new Error("LLM API down (simulated)");
    if (req.task === "extractPlan") {
      const msgs = (JSON.parse(req.user) as { messages?: string[] }).messages ?? [];
      const last = (msgs[msgs.length - 1] ?? "").toLowerCase();
      const hit = (s.extract ?? []).find((e) => last.includes(e.match.toLowerCase()));
      if (!hit) throw new Error("no scripted extraction");
      return { ...EXTRACTION_BASE, ...hit.out };
    }
    if (req.task === "classifyReply") {
      const msg = String((JSON.parse(req.user) as { message?: string }).message ?? "").toLowerCase();
      const hit = (s.classify ?? []).find((c) => msg.includes(c.match.toLowerCase()));
      if (!hit) throw new Error("no scripted classification");
      return { label: hit.label, command: hit.command ?? null, extendMin: hit.extendMin ?? null, confidence: hit.confidence ?? 0.95 };
    }
    throw new Error("no phrasing in sims"); // copy falls back to the question bank
  });
}

// ---------- quota policy (spec 8.5) ----------

/**
 * GLUE: the real quota tracker belongs to the gateway (not merged yet). This policy is the
 * blueprint: count every outbound and every first message to a new address per UTC day; near
 * the cap, refuse new onboarding; safety (engine) messages are always sent.
 */
export class QuotaPolicy {
  static readonly MESSAGES_PER_DAY = 5000;
  static readonly NEW_CONVERSATIONS_PER_DAY = 50;
  /** "Near the cap": this many messages or new conversations left. */
  static readonly MARGIN = 0.05;
  private readonly seen = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly clock: FakeClock,
  ) {}
  day(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
  messages(): number {
    return repo.getCounter(this.store, this.day(), "messages_sent");
  }
  newConversations(): number {
    return repo.getCounter(this.store, this.day(), "new_conversations");
  }
  countSend(address: E164): void {
    repo.incrementCounter(this.store, this.day(), "messages_sent");
    if (!this.seen.has(address)) {
      this.seen.add(address);
      repo.incrementCounter(this.store, this.day(), "new_conversations");
    }
  }
  markKnown(address: E164): void {
    this.seen.add(address);
  }
  nearCap(): boolean {
    const m = QuotaPolicy.MESSAGES_PER_DAY;
    const c = QuotaPolicy.NEW_CONVERSATIONS_PER_DAY;
    return this.messages() >= m * (1 - QuotaPolicy.MARGIN) || this.newConversations() >= c * (1 - QuotaPolicy.MARGIN);
  }
  /** Test helper: preload today's counters. */
  preload(messages: number, newConversations = 0): void {
    repo.incrementCounter(this.store, this.day(), "messages_sent", messages);
    repo.incrementCounter(this.store, this.day(), "new_conversations", newConversations);
  }
}

// ---------- the harness ----------

export interface FullStackOptions {
  track?: string;
  llm?: LlmScript | LlmProvider | null;
  /** Calls connect (default true). */
  callsWork?: boolean;
  /** Fake-clock time spent inside CallService.place(). */
  callLatencyMs?: number;
  /** Minutes the user takes to accept the Find My card (default 1). */
  acceptDelayMin?: number;
  /** Clock start in minutes from START (default -240). */
  startMin?: number;
  dbPath?: string;
  geocoder?: Record<string, GeocodeResult>;
  userHome?: { lat: number; lng: number } | null;
  /** Queue the track's userMessages as user texts (default true). Labels are ignored: NLU decides. */
  trackMessages?: boolean;
}

export type InboundItem = { t: number; from: Role | E164; content: InboundContent };

const rel = (d: Date) => Math.round(((d.getTime() - START.getTime()) / MIN) * 100) / 100;

export class FullStack {
  readonly clock: FakeClock;
  store!: Store;
  scheduler!: JobScheduler;
  runtime!: PlanRuntime;
  repo!: StoreDialogueRepo;
  ports!: DialoguePorts;
  quota!: QuotaPolicy;
  readonly channel: FakeChannel;
  readonly calls: FakeCallService;
  readonly location = new FakeLocationSource();
  readonly llm: LlmProvider | null;
  readonly track: MaterializedTrack | null;
  readonly sent: Sent[] = [];
  readonly callLog: CallRec[] = [];
  /** Sends the executor dropped because the address said STOP (I14). */
  readonly dropped: { t: number; address: E164; template: TemplateId | null }[] = [];
  readonly routes: { t: number; from: E164; route: string }[] = [];
  readonly errors: unknown[] = [];
  readonly registered: E164[] = [];
  /** Every inbound message id with its time and sender. */
  readonly inboundLog: { t: number; at: Date; id: string; from: E164 }[] = [];
  private script: { at: Date; item: InboundItem }[] = [];
  private scriptPtr = 0;
  private fixPtr = 0;
  private watchPlanId: string | null = null;
  private locRequestedAt: Date | null = null;
  private inSeq = 0;
  private evSeq = 0;
  private pendingFixes: Promise<unknown>[] = [];
  /** GLUE: the dialogue's dispatch() has no message id; the runtime wants lastUserMessageId. */
  private readonly lastInbound = new Map<string, string>();

  constructor(readonly opts: FullStackOptions = {}) {
    this.clock = new FakeClock(new Date(START.getTime() + (opts.startMin ?? -240) * MIN));
    this.channel = new FakeChannel(this.clock);
    this.calls = new FakeCallService(this.clock, opts.callsWork ?? true, opts.callLatencyMs ?? 0);
    this.track = opts.track ? materializeTrack(loadTrack(join(TRACKS, `${opts.track}.json`)), START) : null;
    const l = opts.llm;
    this.llm = l === undefined || l === null ? null : "parse" in l ? l : scriptedLlm(l);
    this.boot();
    if (this.track && opts.trackMessages !== false) {
      for (const m of this.track.userMessages) this.at((m.at.getTime() - START.getTime()) / MIN, "user", m.text);
    }
  }

  private boot(): void {
    this.store = openStore(this.opts.dbPath ?? ":memory:");
    this.quota = new QuotaPolicy(this.store, this.clock);
    this.scheduler = new JobScheduler(this.store, (job) => this.handleJob(job), { clock: this.clock, onError: (_j, e) => this.errors.push(e) });
    this.runtime = new PlanRuntime({
      store: this.store,
      clock: this.clock,
      jobs: this.scheduler,
      out: this.executor(),
      defaultTz: TZ,
      shareProbe: async () => {
        const accepted = this.track ? this.track.share.accepted : false;
        const delay = (this.opts.acceptDelayMin ?? 1) * MIN;
        const visible = accepted && !!this.locRequestedAt && this.clock.now().getTime() >= this.locRequestedAt.getTime() + delay;
        return { visible, expiresAt: this.track?.share.expiresAt ?? null };
      },
      onError: (e) => this.errors.push(e),
      lastUserMessageId: (plan) => this.lastInbound.get(plan.userId) ?? null,
    });
    const prevRepo: StoreDialogueRepo | undefined = this.repo;
    this.repo = new StoreDialogueRepo(this.store, () => this.runtime, this.clock);
    if (prevRepo) {
      // Side maps model tables that do not exist yet; carry them over a restart.
      for (const [k, v] of prevRepo.optinSentAt) this.repo.optinSentAt.set(k, v);
      for (const [k, v] of prevRepo.stopped) this.repo.stopped.set(k, v);
      for (const [k, v] of prevRepo.dialogue) this.repo.dialogue.set(k, v);
    }
    this.ports = this.dialoguePorts();
  }

  private async handleJob(job: Parameters<PlanRuntime["handleJob"]>[0]): Promise<void> {
    if (job.planId) return this.runtime.handleJob(job);
    // GLUE: non-plan jobs scheduled by the dialogue (guardian opt-in expiry, 4.3).
    if (job.kind === "optin_expire" && job.payload) {
      await handleOptinExpire(this.ports, job.payload as { userId: string; guardianId: string });
    }
  }

  roleOf(address: E164): Role {
    if (repo.getUserByAddress(this.store, address)) return "user";
    if (repo.getGuardianByAddress(this.store, address)) return "guardian";
    return "other";
  }

  private planStateFor(address: E164): PlanState | null {
    const u = repo.getUserByAddress(this.store, address);
    return u ? (repo.getOpenPlanForUser(this.store, u.id)?.state ?? null) : null;
  }

  private record(address: E164, template: TemplateId | null, text: string, origin: Sent["origin"], ref: SentRef, extra: Partial<Sent> = {}): void {
    this.sent.push({ t: rel(this.clock.now()), at: this.clock.now(), to: this.roleOf(address), address, template, text, origin, state: this.planStateFor(address), id: ref.id, seq: ++this.evSeq, ...extra });
  }

  /** GLUE: engine send params use different keys than notify/templates.ts TemplateParams. */
  engineParams(e: SendEffect, plan: EnginePlan): TemplateParams {
    const p = (e.params ?? {}) as Record<string, unknown>;
    const lastFix = p.lastFix as TemplateParams["fix"] | undefined;
    return {
      ...(p as TemplateParams),
      plan,
      tz: (p.timeZone as string | undefined) ?? TZ,
      now: this.clock.now(),
      type: plan.type,
      // The engine sends reason as a kind string; templates expect the EscalationReason object.
      reason: plan.escalationReason,
      fix: lastFix ?? null,
      locationMode: plan.locationMode,
    };
  }

  /** GLUE: the OutboundPort the gateway executor must implement. */
  private executor(): OutboundPort {
    return {
      send: async (e, plan) => {
        const address = this.addressFor(e.to, plan);
        if (!address) return null;
        // GLUE (I14): the engine does not know about STOP; the executor drops these sends.
        const g = plan.guardianId ? repo.getGuardian(this.store, plan.guardianId) : null;
        if (this.repo.isStoppedSync(address) || (e.to === "guardian" && g?.stoppedAt)) {
          this.dropped.push({ t: rel(this.clock.now()), address, template: e.template });
          return null;
        }
        const text = renderTemplate(e.template, this.engineParams(e, plan), { variant: 0 });
        const ref = await this.channel.sendText(address, text);
        this.quota.countSend(address);
        const extra: Partial<Sent> = {};
        if (e.critical) extra.critical = true;
        if (e.notifyAnyway) extra.notifyAnyway = true;
        this.record(address, e.template, text, "engine", ref, extra);
        if (e.notifyAnyway) await this.channel.notifyAnyway(address, ref);
        return ref;
      },
      react: async (e) => {
        if (e.messageId) await this.channel.react(e.messageId);
      },
      call: async (e, plan) => {
        const address = this.addressFor(e.to, plan);
        if (!address || this.repo.isStoppedSync(address)) return false;
        const user = repo.getUser(this.store, plan.userId);
        const at = this.clock.now();
        const seq = ++this.evSeq;
        const placed = await this.calls.place(address, e.script, { decoy: user?.decoyCaller ?? "roommate", userName: user?.displayName ?? "" });
        this.callLog.push({ t: rel(at), at, to: e.to, address, script: e.script, placed, returnedAt: this.clock.now(), seq });
        return placed;
      },
      requestLocation: async () => {
        this.locRequestedAt = this.clock.now();
      },
      startWatch: async (plan) => {
        const user = repo.getUser(this.store, plan.userId);
        if (!user) return;
        if (this.watchPlanId !== plan.id) this.skipPastFixes();
        this.watchPlanId = plan.id;
        const planId = plan.id;
        // I2 + I3 guard on every fix, exactly as the Find My source must apply it.
        const guarded = guardedFixHandler(user.addressE164, () => repo.getPlan(this.store, planId)?.state ?? null, (fix) => {
          this.pendingFixes.push(this.runtime.ingestFix(planId, fix));
        });
        await this.location.start(user.addressE164, guarded as unknown as (fix: Fix) => void);
      },
      stopWatch: async () => {
        this.watchPlanId = null;
        await this.location.stop();
      },
    };
  }

  private addressFor(to: "user" | "guardian", plan: EnginePlan): E164 | null {
    if (to === "user") return repo.getUser(this.store, plan.userId)?.addressE164 ?? null;
    return plan.guardianId ? (repo.getGuardian(this.store, plan.guardianId)?.addressE164 ?? null) : null;
  }

  private dialoguePorts(): DialoguePorts {
    const tzFor = (address: E164) => repo.getUserByAddress(this.store, address)?.tz ?? TZ;
    const deliver = async (to: E164, template: TemplateId | null, text: string): Promise<SentRef | null> => {
      // I14 at the port as well (the dialogue checks too; startOnboarding calls the port directly).
      if (this.repo.isStoppedSync(to) && template !== "stop_ack") {
        this.dropped.push({ t: rel(this.clock.now()), address: to, template });
        return null;
      }
      const ref = await this.channel.sendText(to, text);
      this.quota.countSend(to);
      this.record(to, template, text, "dialogue", ref);
      return ref;
    };
    return {
      repo: this.repo,
      clock: this.clock,
      dispatch: (planId, event) => this.dispatch(planId, event),
      sendTemplate: (to, template, params = {}) => deliver(to, template, renderTemplate(template, { tz: tzFor(to), now: this.clock.now(), ...params }, { variant: 0 })),
      sendText: (to, text) => deliver(to, null, text),
      react: (messageId) => this.channel.react(messageId),
      typing: (to, fn) => this.channel.typing(to, fn),
      shareContactCard: (to) => this.channel.shareContactCard(to),
      registerGuardianAddress: async (address) => {
        this.registered.push(address);
        return { assignedNumber: GUARDIAN_POOL, smsLink: `sms:${GUARDIAN_POOL}` };
      },
      isIMessageAvailable: async () => true,
      schedule: async (job) => {
        this.scheduler.enqueue(job);
      },
      geocoder: new FixedGeocoder(this.opts.geocoder ?? DEFAULT_GEO),
      llm: this.llm,
      config: { defaultTz: TZ, allowNewConversation: async () => !this.quota.nearCap() },
      rng: () => 0,
    };
  }

  /** GLUE: DialoguePorts.dispatch -> PlanRuntime.dispatch. */
  async dispatch(planId: string, event: DialogueEvent): Promise<void> {
    try {
      if (event.type === "plan_edited") {
        await this.applyPlanEdited(planId, event.fields);
        return;
      }
      const plan = repo.getPlan(this.store, planId);
      const last = plan ? this.lastInbound.get(plan.userId) : undefined;
      await this.runtime.dispatch(planId, event, last ? { lastUserMessageId: last } : {});
    } catch (err) {
      this.errors.push(err);
    }
  }

  /**
   * GLUE: plan_edited is not an engine event. The dialogue already wrote the new fields; here
   * the timers that depend on them are rescheduled with the same math as the engine's armPlan
   * and scheduleEndGrace. Recommended fix: a plan_edited row in the engine.
   */
  private async applyPlanEdited(planId: string, fields: PlanEditField[]): Promise<void> {
    const p = repo.getPlan(this.store, planId);
    if (!p) return;
    repo.addPlanEvent(this.store, planId, "plan_edited", { fields }, this.clock.now());
    const now = this.clock.now().getTime();
    if (fields.includes("startAt") && p.startAt && (p.state === "ARMED" || p.state === "PRE_MEETUP")) {
      const start = p.startAt.getTime();
      if (p.state === "ARMED") {
        this.scheduler.cancel(planId, ["t_minus_30", "start"]);
        this.scheduler.enqueue({ kind: "t_minus_30", runAt: new Date(Math.max(now, start - T_MINUS_MS)), planId });
      } else this.scheduler.cancel(planId, ["start"]);
      this.scheduler.enqueue({ kind: "start", runAt: new Date(Math.max(now, start)), planId });
    }
    if (p.state === "AWAITING_GUARDIAN" && fields.includes("endAt") && p.endAt) {
      this.scheduler.cancel(planId, ["draft_expire"]);
      this.scheduler.enqueue({ kind: "draft_expire", runAt: p.endAt, planId });
    }
  }

  // ---------- inbound ----------

  private resolve(from: Role | E164): E164 {
    if (from === "user") return USER;
    if (from === "guardian") return GUARDIAN;
    if (from === "other") return STRANGER;
    return from;
  }

  /** Deliver one inbound message now: dedupe (8.4 step 4), then the dialogue manager. */
  async inbound(from: Role | E164, content: InboundContent, id?: string): Promise<string> {
    const address = this.resolve(from);
    const msgId = id ?? `in-${++this.inSeq}`;
    if (!repo.markInboundProcessed(this.store, msgId, this.clock.now())) return "duplicate";
    this.inboundLog.push({ t: rel(this.clock.now()), at: this.clock.now(), id: msgId, from: address });
    this.quota.markKnown(address);
    const u = repo.getUserByAddress(this.store, address);
    if (u) this.lastInbound.set(u.id, msgId);
    let route = "error";
    try {
      route = (await handleInbound(this.ports, { id: msgId, from: address, at: this.clock.now(), content })).route;
    } catch (err) {
      this.errors.push(err);
    }
    const nu = repo.getUserByAddress(this.store, address);
    if (nu) this.lastInbound.set(nu.id, msgId);
    this.routes.push({ t: rel(this.clock.now()), from: address, route });
    await this.flushFixes();
    return route;
  }

  text(from: Role | E164, text: string, opts: { fromVoice?: boolean } = {}): Promise<string> {
    return this.inbound(from, { kind: "text", text, ...(opts.fromVoice ? { fromVoice: true } : {}) });
  }

  /** Queue an inbound message at minute `t` (relative to START). */
  at(t: number, from: Role | E164, textOrContent: string | InboundContent): this {
    const content: InboundContent = typeof textOrContent === "string" ? { kind: "text", text: textOrContent } : textOrContent;
    this.script.push({ at: new Date(START.getTime() + t * MIN), item: { t, from, content } });
    this.script.sort((a, b) => a.at.getTime() - b.at.getTime());
    return this;
  }

  // ---------- running ----------

  private skipPastFixes(): void {
    const fixes = this.track?.fixes ?? [];
    const now = this.clock.now().getTime();
    while (this.fixPtr < fixes.length && fixes[this.fixPtr]!.at.getTime() < now) this.fixPtr++;
  }

  private nextFixAt(): Date | null {
    if (!this.location.handler || !this.track) return null;
    return this.track.fixes[this.fixPtr]?.at ?? null;
  }

  private async flushFixes(): Promise<void> {
    while (this.pendingFixes.length > 0) {
      const batch = this.pendingFixes.splice(0);
      for (const p of batch) {
        try {
          await p;
        } catch (err) {
          this.errors.push(err);
        }
      }
    }
  }

  /** Run fixes, scripted inbound messages, and due jobs in time order up to minute `tMin`. */
  async runUntil(tMin: number): Promise<void> {
    const target = START.getTime() + tMin * MIN;
    for (let guard = 0; guard < 100_000; guard++) {
      const job = this.scheduler.nextRunAt();
      const fix = this.nextFixAt();
      const msg = this.script[this.scriptPtr]?.at ?? null;
      const candidates = [fix, msg, job].filter((d): d is Date => d !== null);
      if (candidates.length === 0) break;
      const next = Math.max(this.clock.now().getTime(), Math.min(...candidates.map((d) => d.getTime())));
      if (next > target) break;
      await this.clock.set(new Date(next));
      if (fix && fix.getTime() <= next) {
        const f = this.track!.fixes[this.fixPtr++]!;
        this.location.handler?.(f, this.location.address);
        await this.flushFixes();
        continue;
      }
      if (msg && msg.getTime() <= next) {
        const { item } = this.script[this.scriptPtr++]!;
        await this.inbound(item.from, item.content);
        continue;
      }
      await this.scheduler.runDue();
      await this.flushFixes();
    }
    if (this.clock.now().getTime() < target) await this.clock.set(new Date(target));
  }

  /** Simulate a process restart on the same database file. */
  async restart(): Promise<void> {
    if (!this.opts.dbPath) throw new Error("restart needs dbPath");
    this.store.close();
    const watching = this.watchPlanId;
    this.location.handler = null;
    this.boot();
    this.scheduler.recoverInterrupted();
    // Production re-attaches watchers for plans in a window on boot.
    if (watching) {
      const p = repo.getPlan(this.store, watching);
      if (p) await this.executor().startWatch(p);
    }
    await this.scheduler.runDue();
  }

  // ---------- canned flows ----------

  /**
   * Full onboarding through the dialogue (4.2, 4.3 with the shared-pool deviation): name,
   * guardian, guardian texts first, guardian YES, code words. `guardianAccepts: false` leaves
   * the guardian silent (never texts Batman).
   */
  async onboard(opts: { guardianAccepts?: boolean; name?: string } = {}): Promise<void> {
    await this.text("user", "hi");
    await this.text("user", opts.name ?? "Alex");
    await this.text("user", "Priya +1 919 555 0142");
    if (opts.guardianAccepts !== false) {
      await this.text("guardian", "hi");
      await this.text("guardian", "yes");
    }
    await this.text("user", "exit pineapple, alert blue moon");
    const u = repo.getUserByAddress(this.store, USER);
    if (u) repo.updateUser(this.store, u.id, { tz: TZ, ...(this.opts.userHome ? { homeLat: this.opts.userHome.lat, homeLng: this.opts.userHome.lng } : {}) });
  }

  /** Plan the standard date through intake and say GO. */
  async planDate(text = DATE_TEXT): Promise<void> {
    await this.text("user", text);
    await this.text("user", "go");
  }

  // ---------- queries ----------

  user() {
    return repo.getUserByAddress(this.store, USER);
  }

  plan(): EnginePlan | null {
    const u = this.user();
    if (!u) return null;
    return repo.getOpenPlanForUser(this.store, u.id) ?? this.lastPlan(u.id);
  }

  private lastPlan(userId: string): EnginePlan | null {
    const row = this.store.sqlite.prepare("SELECT id FROM plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(userId) as { id: string } | undefined;
    return row ? repo.getPlan(this.store, row.id) : null;
  }

  /** "role:template" (template "text" for free copy) for sends at or after `sinceMin`. */
  sends(sinceMin = -Infinity, to?: Role): string[] {
    return this.sent.filter((s) => s.t >= sinceMin && (!to || s.to === to)).map((s) => `${s.to}:${s.template ?? "text"}`);
  }

  /** Timeline lines "t send role:template" and "t call role:script(placed)". */
  timeline(sinceMin = -Infinity): string[] {
    const items: { seq: number; line: string }[] = [];
    for (const s of this.sent) if (s.t >= sinceMin) items.push({ seq: s.seq, line: `${s.t} send ${s.to}:${s.template ?? "text"}` });
    for (const c of this.callLog) if (c.t >= sinceMin) items.push({ seq: c.seq, line: `${c.t} call ${c.to}:${c.script}${c.placed ? "" : " (failed)"}` });
    return items.sort((a, b) => a.seq - b.seq).map((i) => i.line);
  }

  guardianSends(): Sent[] {
    return this.sent.filter((s) => s.to === "guardian");
  }

  transitions(): string[] {
    const p = this.plan();
    if (!p) return [];
    return repo
      .listPlanEvents(this.store, p.id)
      .filter((e) => e.kind === "state")
      .map((e) => `${String(e.data?.from)}->${String(e.data?.to)}`);
  }

  /** Every user-facing message sent while the plan was in a discreet state (I10). */
  discreetSends(): Sent[] {
    return this.sent.filter((s) => s.to === "user" && s.state !== null && DISCREET_STATES.includes(s.state));
  }

  close(): void {
    this.store.close();
  }
}
