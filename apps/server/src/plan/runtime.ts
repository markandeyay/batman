// PlanRuntime: loads a plan, runs the pure engine, persists the result, and performs effects.
// Internal effects (schedule, cancel_jobs, audit, purge_location) are applied here against the
// store and scheduler. Outbound effects (send, react, call, location) go through an
// OutboundPort that the gateway layer implements (tests record them). Events for one plan are
// serialized. Spec 6.3 (idempotent durable jobs), 6.6 step 3 (call fallback), I3, I12, I16.
import type { Clock, Effect, EngineEvent, Fix, JobKind, JobSpec, SentRef } from "../contracts.js";
import type { JobRecord } from "../scheduler/jobs.js";
import type { Store } from "../store/db.js";
import * as repo from "../store/repo.js";
import { buildContext } from "./context.js";
import { newDraftPlan, type DraftInput } from "./factory.js";
import { acceptsFixes, applyEvent, type EngineOutput } from "./stateMachine.js";
import type { EngineContext, EnginePlan } from "./types.js";

export type SendEffect = Extract<Effect, { kind: "send" }>;
export type ReactEffect = Extract<Effect, { kind: "react" }>;
export type CallEffect = Extract<Effect, { kind: "call" }>;

/** Performs user- and guardian-facing effects. Implemented by the gateway executor. */
export interface OutboundPort {
  /** Render and send a template. Returns the sent message ref (for check-in tracking) or null. */
  send(effect: SendEffect, plan: EnginePlan): Promise<SentRef | null>;
  react(effect: ReactEffect, plan: EnginePlan): Promise<void>;
  /**
   * Place a call and resolve with whether it was placed (false: skipped or failed). May take as
   * long as the call itself; the runtime never awaits it inline (H5) and bounds it with a timeout.
   */
  call(effect: CallEffect, plan: EnginePlan): Promise<boolean>;
  requestLocation(plan: EnginePlan): Promise<void>;
  startWatch(plan: EnginePlan): Promise<void>;
  stopWatch(plan: EnginePlan): Promise<void>;
}

export interface JobQueue {
  enqueue(spec: JobSpec): unknown;
  cancel(planId: string, kinds?: readonly JobKind[]): unknown;
}

export interface PlanRuntimeOptions {
  store: Store;
  clock: Clock;
  jobs: JobQueue;
  out: OutboundPort;
  defaultTz: string;
  /** Find My visibility check for loc_poll and t_minus_30 (4.5). Absent: treated as not visible. */
  shareProbe?: (plan: EnginePlan) => Promise<{ visible: boolean; expiresAt: Date | null }>;
  /**
   * Latest inbound message id from the plan's user. Share acceptance is usually found by a
   * loc_poll job, which has no inbound message; this supplies the 4.5 step 3 tapback target.
   */
  lastUserMessageId?: (plan: EnginePlan) => string | null;
  /** Override night detection (tests). */
  night?: boolean;
  /** Audit events that must be logged at critical level (M7: escalation with no reachable guardian). */
  onCritical?: (event: string, info: { planId: string; data?: Record<string, unknown> }) => void;
  /** Hard real-time bound on one call placement (H5). Default 60 s. A timeout counts as not placed. */
  callTimeoutMs?: number;
  onError?: (err: unknown, info: { planId: string; event?: string; effect?: string }) => void;
}

const SHARE_JOBS: readonly JobKind[] = ["loc_poll", "t_minus_30"];

export const CALL_TIMEOUT_MS = 60_000;

/** Engine audit events that the runtime reports through onCritical (M7, X3). */
export const CRITICAL_AUDITS: readonly string[] = ["escalation_no_guardian", "escalation_guardian_lost", "fallback_guardian_alert"];

export class PlanRuntime {
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Calls running in the background, with their call_result dispatch (H5). */
  private readonly pendingCalls = new Set<Promise<void>>();

  constructor(private readonly o: PlanRuntimeOptions) {}

  /** Resolves when background calls and their call_result events have finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pendingCalls.size > 0) await Promise.allSettled([...this.pendingCalls]);
    await Promise.allSettled([...this.queues.values()]);
  }

  /** Insert a new DRAFT and schedule its 12 h expiry. */
  createDraft(input: Omit<DraftInput, "now">): EnginePlan {
    const { plan, effects } = newDraftPlan({ ...input, now: this.o.clock.now() });
    this.o.store.sqlite.transaction(() => {
      repo.insertPlan(this.o.store, plan);
      for (const e of effects) this.applyInternal(plan.id, e);
    })();
    return plan;
  }

  /** Apply one event to a plan, persist, and perform effects. Serialized per plan. */
  dispatch(planId: string, event: EngineEvent, extra: Pick<EngineContext, "share" | "lastUserMessageId"> = {}): Promise<EngineOutput | null> {
    return this.serial(planId, () => this.dispatchNow(planId, event, extra));
  }

  /** I3: store and process a fix only while the plan is in a window; otherwise discard it. */
  ingestFix(planId: string, fix: Fix): Promise<boolean> {
    return this.serial(planId, async () => {
      const plan = repo.getPlan(this.o.store, planId);
      if (!plan || !acceptsFixes(plan.state)) return false;
      repo.insertFix(this.o.store, planId, fix, this.o.clock.now());
      await this.dispatchNow(planId, { type: "fix", fix }, {});
      return true;
    });
  }

  /** Scheduler handler. Plan jobs become timer events; the engine re-checks state (idempotent). */
  async handleJob(job: JobRecord): Promise<void> {
    if (!job.planId) return;
    const planId = job.planId;
    const event: EngineEvent = job.payload ? { type: "timer", job: job.kind, payload: job.payload } : { type: "timer", job: job.kind };
    await this.serial(planId, async () => {
      const extra: Pick<EngineContext, "share" | "lastUserMessageId"> = {};
      if (SHARE_JOBS.includes(job.kind) && this.o.shareProbe) {
        const plan = repo.getPlan(this.o.store, planId);
        if (plan) {
          const last = this.o.lastUserMessageId?.(plan);
          if (last) extra.lastUserMessageId = last;
          try {
            extra.share = await this.o.shareProbe(plan);
          } catch (err) {
            this.o.onError?.(err, { planId, event: `timer:${job.kind}`, effect: "share_probe" });
          }
        }
      }
      await this.dispatchNow(planId, event, extra);
    });
  }

  private serial<T>(planId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(planId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(planId, settled);
    void settled.then(() => {
      if (this.queues.get(planId) === settled) this.queues.delete(planId);
    });
    return next;
  }

  private async dispatchNow(planId: string, event: EngineEvent, extra: Pick<EngineContext, "share" | "lastUserMessageId">): Promise<EngineOutput | null> {
    const plan = repo.getPlan(this.o.store, planId);
    if (!plan) return null;
    const now = this.o.clock.now();
    const ctx = buildContext(this.o.store, plan, now, this.o.defaultTz, this.o.night === undefined ? extra : { ...extra, night: this.o.night });
    let out: EngineOutput;
    try {
      out = applyEvent(plan, event, ctx);
    } catch (err) {
      this.o.onError?.(err, { planId, event: event.type });
      // I16: fail toward the user with a plain check-in, then let the caller retry.
      if (event.type !== "internal_error" && acceptsFixes(plan.state)) {
        await this.dispatchNow(planId, { type: "internal_error", message: err instanceof Error ? err.message : String(err) }, {});
      }
      throw err;
    }
    // Persist the new plan and internal effects atomically, before anything leaves the process.
    this.o.store.sqlite.transaction(() => {
      repo.savePlan(this.o.store, out.plan);
      for (const e of out.effects) this.applyInternal(planId, e);
    })();
    await this.performOutbound(out.plan, out.effects);
    return out;
  }

  private applyInternal(planId: string, e: Effect): void {
    const now = this.o.clock.now();
    switch (e.kind) {
      case "schedule":
        this.o.jobs.enqueue(e.job);
        break;
      case "cancel_jobs":
        this.o.jobs.cancel(planId, e.kinds);
        break;
      case "audit":
        repo.addPlanEvent(this.o.store, planId, e.event, e.data, now);
        if (CRITICAL_AUDITS.includes(e.event)) this.o.onCritical?.(e.event, e.data ? { planId, data: e.data } : { planId });
        break;
      case "purge_location":
        repo.purgePlanLocation(this.o.store, planId);
        break;
      default:
        break;
    }
  }

  /**
   * H5 (10.4 "Text first, then call"): every non-call effect runs first, in order, then calls
   * start in the background. A call never blocks this plan's queue or the scheduler.
   */
  private async performOutbound(plan: EnginePlan, effects: Effect[]): Promise<void> {
    let tracked: SentRef | null = null;
    const calls: CallEffect[] = [];
    for (const e of effects) {
      if (e.kind === "call") {
        calls.push(e);
        continue;
      }
      try {
        switch (e.kind) {
          case "send": {
            const ref = await this.o.out.send(e, plan);
            if (e.track && ref) tracked = ref;
            break;
          }
          case "react":
            await this.o.out.react(e, plan);
            break;
          case "request_location":
            await this.o.out.requestLocation(plan);
            break;
          case "start_watch":
            await this.o.out.startWatch(plan);
            break;
          case "stop_watch":
            await this.o.out.stopWatch(plan);
            break;
          default:
            break;
        }
      } catch (err) {
        // One failed effect never blocks the rest of the safety sequence.
        this.o.onError?.(err, { planId: plan.id, effect: e.kind });
      }
    }
    if (tracked) {
      const fresh = repo.getPlan(this.o.store, plan.id);
      if (fresh) repo.savePlan(this.o.store, { ...fresh, lastCheckinMessageId: tracked.id, lastCheckinAt: tracked.at });
    }
    for (const c of calls) this.startCall(plan, c);
  }

  /**
   * Run one call in the background with a hard timeout, then report it to the engine as a
   * call_result event (fallback text for a failed fake call, honest guardian copy). H5, 6.6.
   */
  private startCall(plan: EnginePlan, e: CallEffect): void {
    const timeoutMs = this.o.callTimeoutMs ?? CALL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const placing = Promise.resolve()
      .then(() => this.o.out.call(e, plan))
      .catch((err: unknown) => {
        this.o.onError?.(err, { planId: plan.id, effect: "call" });
        return false;
      });
    const task = Promise.race([placing, timeout])
      .then(async (placed) => {
        if (timer) clearTimeout(timer);
        await this.dispatch(plan.id, { type: "call_result", script: e.script, placed });
      })
      .catch((err: unknown) => this.o.onError?.(err, { planId: plan.id, event: "call_result" }));
    const tracked: Promise<void> = task.finally(() => this.pendingCalls.delete(tracked));
    this.pendingCalls.add(tracked);
  }
}
