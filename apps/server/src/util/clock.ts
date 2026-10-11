// Clock implementations (spec 6.3, 15.4). Everything time-dependent takes a Clock.
import type { Clock } from "../contracts.js";

export type { Clock };

/** Production clock: wall time and setTimeout. */
export class RealClock implements Clock {
  now(): Date {
    return new Date();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}

interface Sleeper {
  at: number;
  seq: number;
  resolve: () => void;
}

/**
 * Test clock. Time only moves on advance() or set(). Sleepers resolve when the clock passes
 * their deadline, in deadline order, and each woken continuation sees now() equal to its
 * deadline. advance/set settle after the woken continuations had a chance to run.
 */
export class FakeClock implements Clock {
  private t: number;
  private sleepers: Sleeper[] = [];
  private seq = 0;

  constructor(start: Date = new Date("2026-01-01T00:00:00Z")) {
    this.t = start.getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.sleepers.push({ at: this.t + ms, seq: this.seq++, resolve });
    });
  }

  /** Number of pending sleepers. */
  pendingSleepers(): number {
    return this.sleepers.length;
  }

  /** Earliest pending sleeper deadline, or null. */
  nextWakeAt(): Date | null {
    if (this.sleepers.length === 0) return null;
    return new Date(Math.min(...this.sleepers.map((s) => s.at)));
  }

  async advance(ms: number): Promise<void> {
    await this.set(new Date(this.t + Math.max(0, ms)));
  }

  /** Jump to a date. Moving backwards is allowed (no sleepers wake). */
  async set(date: Date): Promise<void> {
    const target = date.getTime();
    if (target < this.t) {
      this.t = target;
      return;
    }
    for (;;) {
      this.sleepers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.sleepers[0];
      if (!next || next.at > target) break;
      this.sleepers.shift();
      this.t = Math.max(this.t, next.at);
      next.resolve();
      await flushMicrotasks();
    }
    this.t = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * Demo clock: simulated time runs timeScale times faster than real time
 * (TIME_SCALE=60 means one real second is one simulated minute). fastForward() backs /ff.
 */
export class ScaledClock implements Clock {
  private readonly scale: number;
  private readonly realNow: () => number;
  private anchorReal: number;
  private anchorSim: number;

  constructor(timeScale: number, opts: { realNow?: () => number; start?: Date } = {}) {
    if (!(timeScale > 0) || !Number.isFinite(timeScale)) throw new Error("timeScale must be a positive number");
    this.scale = timeScale;
    this.realNow = opts.realNow ?? (() => Date.now());
    this.anchorReal = this.realNow();
    this.anchorSim = opts.start ? opts.start.getTime() : this.anchorReal;
  }

  get timeScale(): number {
    return this.scale;
  }

  now(): Date {
    return new Date(this.anchorSim + (this.realNow() - this.anchorReal) * this.scale);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms / this.scale)));
  }

  /** Move simulated time forward by ms (admin /ff). */
  fastForward(ms: number): void {
    const nowSim = this.now().getTime();
    this.anchorReal = this.realNow();
    this.anchorSim = nowSim + Math.max(0, ms);
  }
}

/** Build the process clock from TIME_SCALE (1 = real time). */
export function clockFromTimeScale(timeScale: number): RealClock | ScaledClock {
  return timeScale === 1 ? new RealClock() : new ScaledClock(timeScale);
}
