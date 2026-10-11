import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobScheduler, defaultBackoffMs, type JobRecord } from "../../../apps/server/src/scheduler/jobs.js";
import { openStore, type Store } from "../../../apps/server/src/store/db.js";
import { FakeClock, ScaledClock } from "../../../apps/server/src/util/clock.js";
import { MIN, T0, at } from "./helpers.js";

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mem(): Store {
  const s = openStore(":memory:");
  stores.push(s);
  return s;
}

function setup(store = mem(), clock = new FakeClock(T0)) {
  const ran: { kind: string; at: Date; id: number }[] = [];
  const sched = new JobScheduler(store, async (j) => void ran.push({ kind: j.kind, at: clock.now(), id: j.id }), { clock });
  return { store, clock, sched, ran };
}

describe("JobScheduler", () => {
  it("runs only due jobs, in runAt order", async () => {
    const { sched, clock, ran } = setup();
    sched.enqueue({ kind: "ladder", runAt: at(5), planId: "p" });
    sched.enqueue({ kind: "start", runAt: at(1), planId: "p" });
    sched.enqueue({ kind: "end_grace", runAt: at(10), planId: "p" });
    expect(await sched.runDue()).toBe(0);
    await clock.set(at(6));
    expect(await sched.runDue()).toBe(2);
    expect(ran.map((r) => r.kind)).toEqual(["start", "ladder"]);
    expect(sched.list({ status: "pending" }).map((j) => j.kind)).toEqual(["end_grace"]);
  });

  it("ties on runAt run in insertion order", async () => {
    const { sched, clock, ran } = setup();
    sched.enqueue({ kind: "t_minus_30", runAt: at(0), planId: "p" });
    sched.enqueue({ kind: "start", runAt: at(0), planId: "p" });
    await clock.set(at(0));
    await sched.runDue();
    expect(ran.map((r) => r.kind)).toEqual(["t_minus_30", "start"]);
  });

  it("stores payloads", async () => {
    const store = mem();
    const clock = new FakeClock(T0);
    const seen: JobRecord[] = [];
    const sched = new JobScheduler(store, async (j) => void seen.push(j), { clock });
    sched.enqueue({ kind: "ladder", runAt: at(0), planId: "p", payload: { step: "L2", token: "x" } });
    await sched.runDue();
    expect(seen[0]).toMatchObject({ kind: "ladder", planId: "p", payload: { step: "L2", token: "x" }, attempts: 1 });
  });

  it("cancel by plan and kinds only touches pending jobs", async () => {
    const { sched } = setup();
    sched.enqueue({ kind: "ladder", runAt: at(5), planId: "p" });
    sched.enqueue({ kind: "risk_tick", runAt: at(5), planId: "p" });
    sched.enqueue({ kind: "ladder", runAt: at(5), planId: "q" });
    expect(sched.cancel("p", ["ladder"])).toBe(1);
    expect(sched.cancel("p")).toBe(1);
    expect(sched.cancel("p", [])).toBe(0);
    expect(sched.list({ status: "pending" }).map((j) => j.planId)).toEqual(["q"]);
  });

  it("jobs enqueued by a handler that are already due run in the same pass", async () => {
    const store = mem();
    const clock = new FakeClock(T0);
    const ran: string[] = [];
    const sched: JobScheduler = new JobScheduler(
      store,
      async (j) => {
        ran.push(j.kind);
        if (j.kind === "t_minus_30") sched.enqueue({ kind: "loc_poll", runAt: clock.now(), planId: "p" });
        if (j.kind === "loc_poll") sched.enqueue({ kind: "loc_poll", runAt: new Date(clock.now().getTime() + 30_000), planId: "p" });
      },
      { clock },
    );
    sched.enqueue({ kind: "t_minus_30", runAt: at(0), planId: "p" });
    await sched.runDue();
    expect(ran).toEqual(["t_minus_30", "loc_poll"]);
  });

  it("failed handlers retry with backoff, then fail permanently", async () => {
    const store = mem();
    const clock = new FakeClock(T0);
    let calls = 0;
    const errors: unknown[] = [];
    const sched = new JobScheduler(
      store,
      async () => {
        calls++;
        throw new Error("boom");
      },
      { clock, maxAttempts: 3, onError: (_j, e) => errors.push(e) },
    );
    const id = sched.enqueue({ kind: "ladder", runAt: at(0), planId: "p" });
    await sched.runDue();
    expect(sched.get(id)).toMatchObject({ status: "pending", attempts: 1, lastError: "boom", runAt: new Date(T0.getTime() + 2000) });
    await clock.advance(2000);
    await sched.runDue();
    expect(sched.get(id)).toMatchObject({ status: "pending", attempts: 2, runAt: new Date(T0.getTime() + 2000 + 4000) });
    await clock.advance(4000);
    await sched.runDue();
    expect(sched.get(id)).toMatchObject({ status: "failed", attempts: 3 });
    expect(calls).toBe(3);
    expect(errors).toHaveLength(3);
    expect(defaultBackoffMs(20)).toBe(5 * MIN);
  });

  it("S-06: jobs survive a restart; done jobs are not rerun; interrupted jobs rerun once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batman-sched-"));
    dirs.push(dir);
    const path = join(dir, "batman.db");
    const clock = new FakeClock(T0);

    const s1 = openStore(path);
    const a = setup(s1, clock);
    a.sched.enqueue({ kind: "ladder", runAt: at(5), planId: "p", payload: { step: "L1" } });
    a.sched.enqueue({ kind: "ladder", runAt: at(9), planId: "p", payload: { step: "L2" } });
    const interrupted = a.sched.enqueue({ kind: "risk_tick", runAt: at(6), planId: "p" });
    await clock.set(at(5));
    await a.sched.runDue();
    expect(a.ran.map((r) => r.kind)).toEqual(["ladder"]);
    // Simulate a crash mid-job: the row is left running.
    s1.sqlite.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(interrupted);
    s1.close();

    const s2 = openStore(path);
    stores.push(s2);
    const b = setup(s2, clock);
    expect(b.sched.recoverInterrupted()).toBe(1);
    await clock.set(at(8));
    await b.sched.runDue();
    expect(b.ran.map((r) => r.kind)).toEqual(["risk_tick"]);
    await clock.set(at(9));
    await b.sched.runDue();
    expect(b.ran.map((r) => `${r.kind}@${(r.at.getTime() - T0.getTime()) / MIN}`)).toEqual(["risk_tick@8", "ladder@9"]);
  });

  it("S-25: after a 20 min sleep, overdue jobs run once each, in runAt order", async () => {
    const store = mem();
    const clock = new FakeClock(T0);
    const ran: string[] = [];
    const sched: JobScheduler = new JobScheduler(
      store,
      async (j) => {
        ran.push(`${j.kind}:${(j.runAt.getTime() - T0.getTime()) / MIN}`);
        // A periodic job reschedules from now, so it does not replay every missed tick.
        if (j.kind === "risk_tick") sched.enqueue({ kind: "risk_tick", runAt: new Date(clock.now().getTime() + MIN), planId: "p" });
      },
      { clock },
    );
    sched.enqueue({ kind: "risk_tick", runAt: at(1), planId: "p" });
    sched.enqueue({ kind: "mid_check", runAt: at(12), planId: "p" });
    sched.enqueue({ kind: "end_grace", runAt: at(4), planId: "p" });
    sched.enqueue({ kind: "ladder", runAt: at(30), planId: "p" });
    await clock.set(at(20)); // host was asleep; nothing ran
    await sched.start();
    await sched.stop();
    expect(ran).toEqual(["risk_tick:1", "end_grace:4", "mid_check:12"]);
    expect(sched.list({ status: "pending" }).map((j) => `${j.kind}:${(j.runAt.getTime() - T0.getTime()) / MIN}`)).toEqual(["risk_tick:21", "ladder:30"]);
  });

  it("poll loop runs due jobs on its own with a scaled clock (TIME_SCALE)", async () => {
    const store = mem();
    const clock = new ScaledClock(600, { start: T0 });
    const ran: string[] = [];
    const sched = new JobScheduler(store, async (j) => void ran.push(j.kind), { clock, timeScale: 600 });
    expect(sched.pollIntervalRealMs).toBeCloseTo(2000 / 600);
    await sched.start();
    sched.enqueue({ kind: "start", runAt: new Date(clock.now().getTime() + 30_000), planId: "p" }); // 50 ms real
    const deadline = Date.now() + 2000;
    while (ran.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await sched.stop();
    expect(ran).toEqual(["start"]);
  });
});
