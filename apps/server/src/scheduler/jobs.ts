// Durable job queue (spec 6.3, I16). Jobs are rows in `jobs`; the database is the source of
// truth. A poll loop (every 2 s divided by TIME_SCALE) claims due jobs one at a time inside a
// transaction, in runAt order. setTimeout is only a wake-up optimization. On boot, jobs left
// "running" by a crash return to "pending" and overdue jobs run immediately, oldest first
// (S-06, S-25). Handlers must be idempotent: they re-check plan state before acting.
import type { Clock, JobKind, JobSpec } from "../contracts.js";
import type { Store } from "../store/db.js";

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface JobRecord {
  id: number;
  kind: JobKind;
  planId: string | null;
  runAt: Date;
  payload: Record<string, unknown> | undefined;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

export type JobHandler = (job: JobRecord) => Promise<void>;

export interface SchedulerOptions {
  clock: Clock;
  /** TIME_SCALE (default 1). Poll interval in real time is pollMs / timeScale. */
  timeScale?: number;
  /** Poll interval in clock time (default 2000 ms). */
  pollMs?: number;
  /** Attempts before a job is marked failed (default 5). */
  maxAttempts?: number;
  /** Retry delay in clock ms after the n-th failed attempt (default 2 s x 2^(n-1), max 5 min). */
  backoffMs?: (attempts: number) => number;
  /** Called on every handler failure (log it). */
  onError?: (job: JobRecord, err: unknown) => void;
  /** Upper bound of jobs run per runDue() call (guards against a handler that re-enqueues itself as due). */
  maxPerTick?: number;
}

interface JobRow {
  id: number;
  run_at: number;
  kind: string;
  plan_id: string | null;
  payload_json: string | null;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
}

function toRecord(r: JobRow): JobRecord {
  let payload: Record<string, unknown> | undefined;
  if (r.payload_json) {
    try {
      payload = JSON.parse(r.payload_json) as Record<string, unknown>;
    } catch {
      payload = undefined;
    }
  }
  return {
    id: r.id,
    kind: r.kind as JobKind,
    planId: r.plan_id,
    runAt: new Date(r.run_at),
    payload,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: new Date(r.created_at),
  };
}

export const defaultBackoffMs = (attempts: number): number => Math.min(5 * 60_000, 2000 * 2 ** Math.max(0, attempts - 1));

export class JobScheduler {
  private readonly clock: Clock;
  private readonly timeScale: number;
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempts: number) => number;
  private readonly onError: ((job: JobRecord, err: unknown) => void) | undefined;
  private readonly maxPerTick: number;
  private running = false;
  private busy: Promise<number> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loopDone: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly handler: JobHandler,
    opts: SchedulerOptions,
  ) {
    this.clock = opts.clock;
    this.timeScale = opts.timeScale && opts.timeScale > 0 ? opts.timeScale : 1;
    this.pollMs = opts.pollMs ?? 2000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffMs = opts.backoffMs ?? defaultBackoffMs;
    this.onError = opts.onError;
    this.maxPerTick = opts.maxPerTick ?? 1000;
  }

  /** Real-time poll interval in ms. */
  get pollIntervalRealMs(): number {
    return this.pollMs / this.timeScale;
  }

  enqueue(spec: JobSpec): number {
    const now = this.clock.now().getTime();
    const r = this.store.sqlite
      .prepare("INSERT INTO jobs (run_at, kind, plan_id, payload_json, status, attempts, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)")
      .run(spec.runAt.getTime(), spec.kind, spec.planId, spec.payload ? JSON.stringify(spec.payload) : null, now);
    this.kick();
    return Number(r.lastInsertRowid);
  }

  /** Cancel pending jobs for a plan (all kinds, or only `kinds`). Returns the number cancelled. */
  cancel(planId: string, kinds?: readonly JobKind[]): number {
    if (kinds && kinds.length === 0) return 0;
    if (kinds) {
      const marks = kinds.map(() => "?").join(",");
      return this.store.sqlite
        .prepare(`UPDATE jobs SET status = 'cancelled' WHERE plan_id = ? AND status = 'pending' AND kind IN (${marks})`)
        .run(planId, ...kinds).changes;
    }
    return this.store.sqlite.prepare("UPDATE jobs SET status = 'cancelled' WHERE plan_id = ? AND status = 'pending'").run(planId).changes;
  }

  /** Jobs left "running" by a crash go back to "pending" (handlers are idempotent). */
  recoverInterrupted(): number {
    return this.store.sqlite.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run().changes;
  }

  /** Claim the earliest due job inside a transaction. */
  claimNext(): JobRecord | null {
    const now = this.clock.now().getTime();
    return this.store.sqlite.transaction((): JobRecord | null => {
      const row = this.store.sqlite
        .prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC, id ASC LIMIT 1")
        .get(now) as JobRow | undefined;
      if (!row) return null;
      this.store.sqlite.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'pending'").run(row.id);
      return toRecord({ ...row, status: "running", attempts: row.attempts + 1 });
    }).immediate();
  }

  /** Claim up to `limit` due jobs at once (all marked running), in runAt order. */
  claimDue(limit = 50): JobRecord[] {
    const out: JobRecord[] = [];
    for (let i = 0; i < limit; i++) {
      const j = this.claimNext();
      if (!j) break;
      out.push(j);
    }
    return out;
  }

  /**
   * Run every due job, one at a time in runAt order, including jobs that become due while
   * running. Returns the number of jobs handled. Concurrent calls share one run.
   */
  runDue(): Promise<number> {
    if (this.busy) return this.busy;
    const run = (async () => {
      await Promise.resolve();
      let n = 0;
      while (n < this.maxPerTick) {
        const job = this.claimNext();
        if (!job) break;
        n++;
        await this.execute(job);
      }
      return n;
    })();
    this.busy = run;
    const clear = () => {
      if (this.busy === run) this.busy = null;
    };
    run.then(clear, clear);
    return run;
  }

  private async execute(job: JobRecord): Promise<void> {
    try {
      await this.handler(job);
      this.store.sqlite.prepare("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = ? AND status = 'running'").run(job.id);
    } catch (err) {
      this.onError?.(job, err);
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (job.attempts >= this.maxAttempts) {
        this.store.sqlite.prepare("UPDATE jobs SET status = 'failed', last_error = ? WHERE id = ?").run(msg, job.id);
      } else {
        const retryAt = this.clock.now().getTime() + this.backoffMs(job.attempts);
        this.store.sqlite.prepare("UPDATE jobs SET status = 'pending', run_at = ?, last_error = ? WHERE id = ?").run(retryAt, msg, job.id);
      }
    }
  }

  nextRunAt(): Date | null {
    const r = this.store.sqlite.prepare("SELECT MIN(run_at) AS t FROM jobs WHERE status = 'pending'").get() as { t: number | null };
    return r.t === null ? null : new Date(r.t);
  }

  get(id: number): JobRecord | null {
    const r = this.store.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return r ? toRecord(r) : null;
  }

  list(filter: { planId?: string; status?: JobStatus; kind?: JobKind } = {}): JobRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.planId !== undefined) {
      where.push("plan_id = ?");
      args.push(filter.planId);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    const sql = `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY run_at ASC, id ASC`;
    return (this.store.sqlite.prepare(sql).all(...args) as JobRow[]).map(toRecord);
  }

  /**
   * Boot: recover interrupted jobs, run overdue ones immediately in runAt order (I16), then
   * poll. Resolves after the first catch-up pass.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.recoverInterrupted();
    await this.runDue();
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wake?.();
    await this.loopDone;
    if (this.busy) await this.busy;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.waitForWork();
      if (!this.running) break;
      try {
        await this.runDue();
      } catch {
        // execute() already records failures; a store error here is retried next poll.
      }
    }
  }

  /** Wait the poll interval, or less if a job is due sooner (wake-up optimization only). */
  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      const next = this.nextRunAt();
      const untilNextReal = next ? Math.max(0, (next.getTime() - this.clock.now().getTime()) / this.timeScale) : Infinity;
      const delay = Math.min(this.pollIntervalRealMs, untilNextReal);
      this.wake = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.wake = null;
        resolve();
      };
      this.timer = setTimeout(() => this.wake?.(), delay);
    });
  }

  /** A new job may be due sooner than the next poll: re-plan the wait. */
  private kick(): void {
    if (this.running && this.wake) this.wake();
  }
}
