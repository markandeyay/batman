// Gateway executor: implements plan/runtime.ts OutboundPort (spec 6.6, 7.1, 8.5, 10.4).
//
// Every outbound Effect kind lands here: send (render() then Channel), react, call, request
// location, start/stop watch. Internal effects (schedule, cancel_jobs, audit, purge_location)
// are applied by PlanRuntime against the store; purgeLocation() is still exposed for callers.
//
// Rules enforced here, at send time:
//   - I14: sends to a stopped address are dropped and logged (the Channel checks the flag at
//     send time, not when the effect was queued). Only stop_ack bypasses it.
//   - I4: location params (fix, lastFix, address, lat, lng) are stripped unless the recipient is
//     the guardian of a plan that is ESCALATED. Coordinates in stored bodies become [loc].
//   - I6: no call or text to an emergency number (Channel and here).
//   - Stored outbound bodies mask the user's code words as [code] (spec 12).
//   - Calls never block: place() runs in the background so the innocuous exit reply and every
//     later effect go out at once. For the fake exit call, if place() resolves false the
//     cw_call_fallback_text goes out immediately (spec 6.6 step 3, within 5 s of that result;
//     Spike S2: shared-pool calls get SIP 403 in about 1.3 s). guardian_alert calls are skipped
//     when speech is off (DECISIONS.md: a tone tells the guardian nothing).
import { z } from "zod";
import { WINDOW_STATES, type CallService, type Clock, type E164, type EngineEvent, type Fix, type LocationSource, type SentRef, type TemplateId } from "../contracts.js";
import type { CallEffect, OutboundPort, ReactEffect, SendEffect } from "../plan/runtime.js";
import type { EnginePlan } from "../plan/types.js";
import type { Store } from "../store/db.js";
import * as repo from "../store/repo.js";
import type { SendOptions } from "./channel.js";
import { StoppedRecipientError, describeError, isEmergencyNumber, last4 } from "./errors.js";
import { dmChatGuid } from "./imessageAdvanced.js";

export type Render = (templateId: TemplateId, params: Record<string, unknown>) => string;

/** The Channel surface the executor needs (GatewayChannel implements it). */
export interface ExecutorChannel {
  send(to: E164, text: string, opts: SendOptions): Promise<SentRef>;
  react(messageId: string, emoji: "like"): Promise<void>;
  notifyAnyway(to: E164, sent: SentRef): Promise<void>;
}

export interface LocationRequestApi {
  request(chat: string, address: string, options?: { readonly clientMessageId?: string }): Promise<unknown>;
}

export interface ExecutorLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ExecutorSinks {
  ingestFix(planId: string, fix: Fix): Promise<unknown>;
  dispatch(planId: string, event: EngineEvent): Promise<unknown>;
}

export interface ExecutorOptions {
  store: Store;
  clock: Clock;
  channel: ExecutorChannel;
  calls: CallService;
  /** capabilities(env).speech */
  speech: boolean;
  render: Render;
  /** Find My request (advanced-imessage locations). null in terminal/replay/none modes. */
  locations?: LocationRequestApi | null;
  /** New LocationSource for one plan's user. onShareEnded maps to location_not_shared. */
  createLocationSource?: (plan: EnginePlan, userAddress: E164, hooks: { onShareEnded: () => void }) => LocationSource;
  logger?: ExecutorLogger;
}

const noop: ExecutorLogger = { info: () => {}, warn: () => {}, error: () => {} };

const LOCATION_PARAM_KEYS = ["fix", "lastFix", "address", "lat", "lng", "latitude", "longitude", "mapsUrl", "locationUrl"];
const COORD_RE = /-?\d{1,3}\.\d{3,}\s*(?:,|%2C|\\,)\s*-?\d{1,3}\.\d{3,}/gi;

const requestReceipt = z.object({ status: z.string() }).passthrough();

/** Mask code words as [code] and coordinate pairs as [loc] for storage (spec 12, I12). */
export function maskForStorage(text: string, codeWords: readonly string[]): string {
  let out = text.replace(COORD_RE, "[loc]");
  for (const w of codeWords) {
    const t = w.trim();
    if (!t) continue;
    out = out.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[code]");
  }
  return out;
}

/** I4: drop location fields unless the guardian of an escalated plan is the recipient. */
export function stripLocationParams(params: Record<string, unknown>, to: "user" | "guardian", plan: EnginePlan): Record<string, unknown> {
  if (to === "guardian" && plan.state === "ESCALATED") return params;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!LOCATION_PARAM_KEYS.includes(k)) out[k] = v;
  return out;
}

interface Recipient {
  address: E164;
  stopped: boolean;
}

export class GatewayExecutor implements OutboundPort {
  private sinks: ExecutorSinks | null = null;
  private readonly sources = new Map<string, LocationSource>();
  private readonly pendingCalls = new Set<Promise<void>>();
  private readonly log: ExecutorLogger;

  constructor(private readonly o: ExecutorOptions) {
    this.log = o.logger ?? noop;
  }

  /** Late binding: PlanRuntime needs the executor, the executor feeds fixes back to the runtime. */
  bind(sinks: ExecutorSinks): void {
    this.sinks = sinks;
  }

  /** Attach the Find My request client once advanced-imessage is connected. */
  setLocations(api: LocationRequestApi | null): void {
    this.o.locations = api;
  }

  /** Resolves when background calls (and their fallbacks) have finished. Tests and shutdown. */
  async idle(): Promise<void> {
    while (this.pendingCalls.size > 0) await Promise.allSettled([...this.pendingCalls]);
  }

  private audit(planId: string, event: string, data?: Record<string, unknown>): void {
    try {
      repo.addPlanEvent(this.o.store, planId, event, data, this.o.clock.now());
    } catch (err) {
      this.log.warn({ planId, event, error: describeError(err) }, "audit write failed");
    }
  }

  private recipient(plan: EnginePlan, to: "user" | "guardian"): Recipient | null {
    if (to === "user") {
      const u = repo.getUser(this.o.store, plan.userId);
      return u && !u.deletedAt ? { address: u.addressE164, stopped: false } : null;
    }
    if (!plan.guardianId) return null;
    const g = repo.getGuardian(this.o.store, plan.guardianId);
    return g ? { address: g.addressE164, stopped: g.stoppedAt !== null } : null;
  }

  private codeWordsFor(userId: string | null): string[] {
    if (!userId) return [];
    try {
      const cw = repo.getCodeWords(this.o.store, userId);
      return cw ? [cw.exit, cw.alert] : [];
    } catch {
      return [];
    }
  }

  private baseParams(plan: EnginePlan): Record<string, unknown> {
    const user = repo.getUser(this.o.store, plan.userId);
    const guardian = plan.guardianId ? repo.getGuardian(this.o.store, plan.guardianId) : null;
    return { plan, userName: user?.displayName ?? null, guardianName: guardian?.displayName ?? null, tz: user?.tz ?? null, now: this.o.clock.now() };
  }

  // ---------- OutboundPort ----------

  async send(effect: SendEffect, plan: EnginePlan): Promise<SentRef | null> {
    const r = this.recipient(plan, effect.to);
    if (!r) {
      this.audit(plan.id, "send_skipped", { template: effect.template, to: effect.to, why: "no_recipient" });
      return null;
    }
    if (r.stopped && effect.template !== "stop_ack") {
      this.log.info({ planId: plan.id, template: effect.template, to: last4(r.address) }, "send dropped: guardian stopped (I14)");
      this.audit(plan.id, "send_dropped_stopped", { template: effect.template, to: effect.to });
      return null;
    }
    const params = stripLocationParams({ ...this.baseParams(plan), ...(effect.params ?? {}) }, effect.to, plan);
    const text = this.o.render(effect.template, params);
    const safety = !!effect.critical || WINDOW_STATES.includes(plan.state);
    try {
      const sent = await this.o.channel.send(r.address, text, {
        critical: !!effect.critical,
        safety,
        kind: effect.template,
        planId: plan.id,
        bypassStop: effect.template === "stop_ack",
        bodyRedacted: maskForStorage(text, this.codeWordsFor(plan.userId)),
      });
      this.audit(plan.id, "outbound", { template: effect.template, to: effect.to });
      if (effect.notifyAnyway) await this.o.channel.notifyAnyway(r.address, sent);
      return sent;
    } catch (err) {
      const info = describeError(err);
      if (err instanceof StoppedRecipientError) {
        this.audit(plan.id, "send_dropped_stopped", { template: effect.template, to: effect.to });
        return null;
      }
      this.audit(plan.id, "send_failed", { template: effect.template, to: effect.to, kind: info.kind, critical: !!effect.critical });
      this.log.warn({ planId: plan.id, template: effect.template, error: info }, "executor send failed");
      return null;
    }
  }

  async react(effect: ReactEffect, _plan: EnginePlan): Promise<void> {
    await this.o.channel.react(effect.messageId, effect.emoji);
  }

  async call(effect: CallEffect, plan: EnginePlan): Promise<boolean> {
    const r = this.recipient(plan, effect.to);
    if (!r || r.stopped) {
      this.audit(plan.id, "call_skipped", { script: effect.script, why: r ? "stopped" : "no_recipient" });
      return false;
    }
    if (isEmergencyNumber(r.address)) {
      this.audit(plan.id, "call_skipped", { script: effect.script, why: "emergency_number" });
      return false;
    }
    if (effect.script === "guardian_alert" && !this.o.speech) {
      this.audit(plan.id, "call_skipped", { script: effect.script, why: "no_speech" });
      return false;
    }
    const user = repo.getUser(this.o.store, plan.userId);
    const ctx = { decoy: user?.decoyCaller ?? "roommate", userName: user?.displayName ?? "" };
    const startedAt = this.o.clock.now();
    this.audit(plan.id, "call_started", { script: effect.script, to: effect.to });
    const task = (async () => {
      let placed = false;
      try {
        placed = await this.o.calls.place(r.address, effect.script, ctx);
      } catch (err) {
        this.log.warn({ planId: plan.id, script: effect.script, error: describeError(err) }, "call threw; treating as not placed");
      }
      this.audit(plan.id, "call_result", { script: effect.script, placed, ms: this.o.clock.now().getTime() - startedAt.getTime() });
      if (!placed && effect.to === "user" && effect.script === "fake") {
        // 6.6 step 3: the text fallback goes out as soon as place() reports failure.
        this.audit(plan.id, "call_fallback", { script: effect.script });
        const fresh = repo.getPlan(this.o.store, plan.id) ?? plan;
        await this.send({ kind: "send", to: "user", template: "cw_call_fallback_text", notifyAnyway: true, critical: true }, fresh);
      }
    })();
    const tracked = task.finally(() => this.pendingCalls.delete(tracked));
    this.pendingCalls.add(tracked);
    // Placement started. Returning true keeps the runtime from sending a second fallback.
    return true;
  }

  async requestLocation(plan: EnginePlan): Promise<void> {
    const r = this.recipient(plan, "user"); // I2: only the plan's own user
    if (!r) return;
    if (!this.o.locations) {
      this.log.info({ planId: plan.id }, "request_location: no Find My client in this mode, skipped");
      this.audit(plan.id, "location_request_skipped", { why: "no_client" });
      return;
    }
    const clientMessageId = `loc-${plan.id}-${(plan.locRequestedAt ?? this.o.clock.now()).getTime()}`;
    try {
      const receipt = requestReceipt.parse(await this.o.locations.request(dmChatGuid(r.address), r.address, { clientMessageId }));
      this.audit(plan.id, "location_requested", { status: receipt.status });
    } catch (err) {
      const info = describeError(err);
      this.audit(plan.id, "location_request_failed", { kind: info.kind });
      this.log.warn({ planId: plan.id, error: info }, "locations.request failed");
    }
  }

  async startWatch(plan: EnginePlan): Promise<void> {
    if (this.sources.has(plan.id)) return;
    const r = this.recipient(plan, "user");
    if (!r || !this.o.createLocationSource) return;
    const planId = plan.id;
    const src = this.o.createLocationSource(plan, r.address, {
      onShareEnded: () => {
        this.audit(planId, "share_ended");
        void this.sinks?.dispatch(planId, { type: "location_not_shared" }).catch((err: unknown) => this.log.warn({ planId, error: describeError(err) }, "share_ended dispatch failed"));
      },
    });
    this.sources.set(planId, src);
    await src.start(r.address, (fix) => {
      if (!this.sources.has(planId)) return; // stopped: drop (I3)
      void this.sinks?.ingestFix(planId, fix).catch((err: unknown) => this.log.warn({ planId, error: describeError(err) }, "ingestFix failed"));
    });
    this.audit(planId, "watch_started");
  }

  async stopWatch(plan: EnginePlan): Promise<void> {
    const src = this.sources.get(plan.id);
    if (!src) return;
    this.sources.delete(plan.id);
    await src.stop();
    this.audit(plan.id, "watch_stopped");
  }

  /** Purge raw fixes for a plan (I12). PlanRuntime does this for the purge_location effect. */
  purgeLocation(planId: string): void {
    repo.purgePlanLocation(this.o.store, planId);
  }

  /** Swap one plan's source (control port POST /replay). */
  async replaceSource(plan: EnginePlan, src: LocationSource): Promise<void> {
    await this.stopWatch(plan);
    const r = this.recipient(plan, "user");
    if (!r) return;
    const planId = plan.id;
    this.sources.set(planId, src);
    await src.start(r.address, (fix) => {
      if (this.sources.get(planId) !== src) return;
      void this.sinks?.ingestFix(planId, fix);
    });
  }

  watching(planId: string): boolean {
    return this.sources.has(planId);
  }

  async stopAll(): Promise<void> {
    const all = [...this.sources.values()];
    this.sources.clear();
    await Promise.allSettled(all.map((s) => s.stop()));
  }

  // ---------- Dialogue ports (sendTemplate / sendText with the same checks) ----------

  /** Render and send outside a plan effect. Returns null when the recipient stopped (I14). Typed errors propagate. */
  async sendTemplateTo(to: E164, template: TemplateId, params: Record<string, unknown> = {}, opts: { planId?: string | null } = {}): Promise<SentRef | null> {
    const text = this.o.render(template, { now: this.o.clock.now(), ...params });
    return this.sendTextTo(to, text, { kind: template, planId: opts.planId ?? null, bypassStop: template === "stop_ack" });
  }

  async sendTextTo(to: E164, text: string, opts: { kind?: string; planId?: string | null; bypassStop?: boolean; safety?: boolean } = {}): Promise<SentRef | null> {
    const user = repo.getUserByAddress(this.o.store, to);
    try {
      return await this.o.channel.send(to, text, {
        kind: opts.kind ?? "text",
        planId: opts.planId ?? null,
        bypassStop: !!opts.bypassStop,
        safety: !!opts.safety,
        bodyRedacted: maskForStorage(text, this.codeWordsFor(user?.id ?? null)),
      });
    } catch (err) {
      if (err instanceof StoppedRecipientError) return null;
      throw err;
    }
  }
}
