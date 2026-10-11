import { describe, expect, it } from "vitest";
import { FakeClock, RealClock, ScaledClock } from "../../../apps/server/src/util/clock.js";

describe("FakeClock", () => {
  it("starts at the given time and advances", async () => {
    const c = new FakeClock(new Date("2026-10-10T19:00:00Z"));
    expect(c.now().toISOString()).toBe("2026-10-10T19:00:00.000Z");
    await c.advance(60_000);
    expect(c.now().toISOString()).toBe("2026-10-10T19:01:00.000Z");
  });

  it("resolves sleepers only when advanced past their deadline, in order", async () => {
    const c = new FakeClock(new Date(0));
    const order: string[] = [];
    void c.sleep(2000).then(() => order.push("b"));
    void c.sleep(1000).then(() => order.push("a"));
    await c.advance(500);
    expect(order).toEqual([]);
    await c.advance(600);
    expect(order).toEqual(["a"]);
    await c.advance(1000);
    expect(order).toEqual(["a", "b"]);
  });

  it("chained sleeps observe the deadline time", async () => {
    const c = new FakeClock(new Date(0));
    const seen: number[] = [];
    void (async () => {
      await c.sleep(1000);
      seen.push(c.now().getTime());
      await c.sleep(1000);
      seen.push(c.now().getTime());
    })();
    await c.advance(5000);
    expect(seen).toEqual([1000, 2000]);
  });

  it("set() jumps to a date and wakes due sleepers", async () => {
    const c = new FakeClock(new Date(0));
    let woke = false;
    void c.sleep(10_000).then(() => (woke = true));
    await c.set(new Date(20_000));
    expect(woke).toBe(true);
    expect(c.now().getTime()).toBe(20_000);
  });

  it("sleep(0) resolves without advancing", async () => {
    const c = new FakeClock(new Date(0));
    await c.sleep(0);
    expect(c.now().getTime()).toBe(0);
  });

  it("returns copies of the current date", () => {
    const c = new FakeClock(new Date(0));
    const d = c.now();
    d.setTime(99);
    expect(c.now().getTime()).toBe(0);
  });
});

describe("ScaledClock", () => {
  it("runs simulated time faster by timeScale", () => {
    let real = 1_000_000;
    const c = new ScaledClock(60, { realNow: () => real, start: new Date(0) });
    real += 1000;
    expect(c.now().getTime()).toBe(60_000);
  });

  it("fastForward shifts simulated time", () => {
    let real = 0;
    const c = new ScaledClock(1, { realNow: () => real, start: new Date(0) });
    c.fastForward(5 * 60_000);
    expect(c.now().getTime()).toBe(300_000);
    real = 10;
    expect(c.now().getTime()).toBe(300_010);
  });

  it("sleep waits ms / timeScale of real time", async () => {
    const c = new ScaledClock(1000);
    const t0 = Date.now();
    await c.sleep(1000);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("rejects a non-positive scale", () => {
    expect(() => new ScaledClock(0)).toThrow();
  });
});

describe("RealClock", () => {
  it("tracks wall time", async () => {
    const c = new RealClock();
    const a = c.now().getTime();
    await c.sleep(5);
    expect(c.now().getTime()).toBeGreaterThanOrEqual(a);
  });
});
