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
  /** Returns false if no call could be placed. */
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
  /** Override night detection (tests). */
  night?: boolean;
  onError?: (err: unknown, info: { planId: string; event?: string; effect?: string }) => void;
}

const SHARE_JOBS: readonly JobKind[] = ["loc_poll", "t_minus_30"];

export class PlanRuntime {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly o: PlanRuntimeOptions) {}

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
      const extra: Pick<EngineContext, "share"> = {};
      if (SHARE_JOBS.includes(job.kind) && this.o.shareProbe) {
        const plan = repo.getPlan(this.o.store, planId);
        if (plan) {
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
        break;
      case "purge_location":
        repo.purgePlanLocation(this.o.store, planId);
        break;
      default:
        break;
    }
  }

  private async performOutbound(plan: EnginePlan, effects: Effect[]): Promise<void> {
    let tracked: SentRef | null = null;
    for (const e of effects) {
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
          case "call": {
            const placed = await this.o.out.call(e, plan);
            if (!placed && e.to === "user" && e.script === "fake") {
              // 6.6 step 3: no call possible, fall back to a text in the decoy's voice.
              repo.addPlanEvent(this.o.store, plan.id, "call_fallback", { script: e.script }, this.o.clock.now());
              await this.o.out.send({ kind: "send", to: "user", template: "cw_call_fallback_text", notifyAnyway: true }, plan);
            }
            break;
          }
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
  }
}
