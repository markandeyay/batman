// Spec 7.1 Find My source: reconnect backoff, sourceSequence dedupe, 60 s heartbeat,
// share-ended callback, acceptance polling, never list().
import { describe, expect, it } from "vitest";
import type { E164, Fix } from "../../../apps/server/src/contracts.js";
import {
  FindMyLocationSource,
  RECONNECT_BACKOFF_MS,
  pollForAcceptance,
  probeShare,
  toFix,
  type FriendLocation,
  type FriendLocationUpdated,
  type LocationsApi,
  type WatchStream,
} from "../../../apps/server/src/location/findmy.js";
import { FakeClock, T0, USER, imErr } from "./gatewayHelpers.js";

class ControlledStream implements WatchStream {
  private queue: FriendLocationUpdated[] = [];
  private waiters: ((r: IteratorResult<FriendLocationUpdated>) => void)[] = [];
  private failer: ((e: Error) => void) | null = null;
  private ended = false;
  push(u: FriendLocationUpdated) {
    const w = this.waiters.shift();
    if (w) w({ value: u, done: false });
    else this.queue.push(u);
  }
  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  fail(e: Error) {
    this.failer?.(e);
  }
  close() {
    this.end();
  }
  [Symbol.asyncIterator](): AsyncIterator<FriendLocationUpdated> {
    return {
      next: () => {
        const v = this.queue.shift();
        if (v) return Promise.resolve({ value: v, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiters.push(resolve);
          this.failer = reject;
        });
      },
    };
  }
}

const loc = (lat: number, extra: Partial<FriendLocation> = {}): FriendLocation => ({
  address: USER,
  latitude: lat,
  longitude: -87.7,
  accuracy: 12,
  locationType: "shallow",
  locationTimestamp: new Date(T0.getTime() + Math.round(lat * 1e6)),
  ...extra,
});

function fakeApi() {
  const streams: ControlledStream[] = [];
  const calls: string[] = [];
  let getImpl: (a: string) => Promise<FriendLocation> = async () => {
    throw imErr("not found", 5, false, "NotFoundError");
  };
  const api: LocationsApi & { list?: never } = {
    get: async (a) => {
      calls.push(`get:${a}`);
      return getImpl(a);
    },
    request: async () => ({ status: "sent" }),
    watch: (a) => {
      calls.push(`watch:${a}`);
      const s = new ControlledStream();
      streams.push(s);
      return s;
    },
  };
  return {
    api,
    streams,
    calls,
    setGet(fn: (a: string) => Promise<FriendLocation>) {
      getImpl = fn;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("toFix and probes", () => {
  it("converts only the user's own location with both coordinates (I2)", () => {
    expect(toFix(loc(41.9), USER, T0)).toMatchObject({ lat: 41.9, lng: -87.7, accuracyM: 12, locationType: "shallow", source: "findmy", expiresAt: null });
    expect(toFix(loc(41.9, { address: "+19195550142" }), USER, T0)).toBeNull();
    expect(toFix({ address: USER, locationType: "unknown" }, USER, T0)).toBeNull();
    expect(toFix(loc(41.9, { accuracy: undefined }), USER, T0)?.accuracyM).toBe(1000);
  });

  it("probeShare: NotFound means not visible; coordinates mean visible", async () => {
    const f = fakeApi();
    expect(await probeShare(f.api, USER)).toEqual({ visible: false, expiresAt: null });
    const exp = new Date(T0.getTime() + 3600_000);
    f.setGet(async () => loc(41.9, { expiresAt: exp }));
    expect(await probeShare(f.api, USER)).toEqual({ visible: true, expiresAt: exp });
  });

  it("pollForAcceptance polls every 30 s and stops at acceptance", async () => {
    const f = fakeApi();
    const clock = new FakeClock(T0);
    let n = 0;
    f.setGet(async () => {
      if (++n < 3) throw imErr("nf", 5, false, "NotFoundError");
      return loc(41.9);
    });
    const p = pollForAcceptance(f.api, USER, { clock });
    await flush();
    await clock.advance(30_000);
    await clock.advance(30_000);
    expect(await p).toMatchObject({ visible: true });
    expect(n).toBe(3);
  });

  it("pollForAcceptance gives up after 15 min", async () => {
    const f = fakeApi();
    const clock = new FakeClock(T0);
    const p = pollForAcceptance(f.api, USER, { clock });
    for (let i = 0; i < 31; i++) await clock.advance(30_000);
    expect(await p).toEqual({ visible: false, expiresAt: null });
    const polls = f.calls.filter((c) => c.startsWith("get")).length;
    expect(polls).toBeGreaterThanOrEqual(30);
    expect(polls).toBeLessThanOrEqual(31);
  });
});

describe("FindMyLocationSource", () => {
  const start = async (opts: { onShareEnded?: () => void } = {}) => {
    const f = fakeApi();
    const clock = new FakeClock(T0);
    const fixes: Fix[] = [];
    const src = new FindMyLocationSource({ api: f.api, clock, ...opts });
    await src.start(USER as E164, (x) => fixes.push(x));
    await flush();
    return { f, clock, fixes, src };
  };

  it("streams fixes and dedupes on sourceSequence", async () => {
    const t = await start();
    t.f.streams[0]!.push({ location: loc(41.9), sourceSequence: 1 });
    t.f.streams[0]!.push({ location: loc(41.9), sourceSequence: 1 });
    t.f.streams[0]!.push({ location: loc(41.91), sourceSequence: 2 });
    await flush();
    expect(t.fixes.map((x) => x.lat)).toEqual([41.9, 41.91]);
    expect(t.src.stats.duplicates).toBe(1);
    await t.src.stop();
  });

  it("drops other addresses on the stream (I2)", async () => {
    const t = await start();
    t.f.streams[0]!.push({ location: loc(40, { address: "+19195550142" }), sourceSequence: 5 });
    await flush();
    expect(t.fixes).toEqual([]);
    expect(t.src.stats.rejectedOtherAddress).toBe(1);
    await t.src.stop();
  });

  it("reconnects with backoff 1, 2, 4, 8 ... max 30 s and resets after data", async () => {
    const t = await start();
    expect(RECONNECT_BACKOFF_MS).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000]);
    t.f.streams[0]!.fail(new Error("stream reset"));
    await flush();
    await t.clock.advance(999);
    expect(t.f.streams.length).toBe(1);
    await t.clock.advance(1);
    expect(t.f.streams.length).toBe(2);
    t.f.streams[1]!.end();
    await flush();
    await t.clock.advance(2000);
    expect(t.f.streams.length).toBe(3);
    t.f.streams[2]!.end();
    await flush();
    await t.clock.advance(4000);
    expect(t.f.streams.length).toBe(4);
    t.f.streams[3]!.push({ location: loc(41.92), sourceSequence: 9 });
    await flush();
    t.f.streams[3]!.end();
    await flush();
    await t.clock.advance(1000); // reset to 1 s after a stream that delivered data
    expect(t.f.streams.length).toBe(5);
    expect(t.fixes).toHaveLength(1);
    await t.src.stop();
  });

  it("caps backoff at 30 s", async () => {
    const t = await start();
    for (let i = 0; i < 8; i++) {
      t.f.streams.at(-1)!.end();
      await flush();
      await t.clock.advance(30_000);
    }
    const before = t.f.streams.length;
    t.f.streams.at(-1)!.end();
    await flush();
    await t.clock.advance(29_999);
    expect(t.f.streams.length).toBe(before);
    await t.clock.advance(1);
    expect(t.f.streams.length).toBe(before + 1);
    await t.src.stop();
  });

  it("get() heartbeat every 60 s emits fixes when the stream is silent", async () => {
    const t = await start();
    t.f.setGet(async () => loc(41.95));
    await t.clock.advance(60_000);
    await flush();
    expect(t.fixes.map((x) => x.lat)).toEqual([41.95]);
    await t.clock.advance(60_000);
    await flush();
    expect(t.fixes).toHaveLength(1); // same fix again is a duplicate
    await t.src.stop();
  });

  it("NOT_FOUND 'not currently sharing' fires onShareEnded once", async () => {
    let ended = 0;
    const t = await start({ onShareEnded: () => void ended++ });
    t.f.setGet(async () => {
      throw imErr("[upstream] Address is not currently sharing a location", 5, false, "NotFoundError");
    });
    await t.clock.advance(60_000);
    await flush();
    await t.clock.advance(60_000);
    await flush();
    expect(ended).toBe(1);
    await t.src.stop();
  });

  it("stop() ends the stream and no fix is delivered afterwards (I3)", async () => {
    const t = await start();
    const s = t.f.streams[0]!;
    await t.src.stop();
    s.push({ location: loc(41.99), sourceSequence: 77 });
    t.f.setGet(async () => loc(41.98));
    await t.clock.advance(120_000);
    await flush();
    expect(t.fixes).toEqual([]);
    expect(t.src.isRunning).toBe(false);
  });

  it("never calls list() (I2 by construction)", async () => {
    const t = await start();
    await t.clock.advance(61_000);
    await t.src.stop();
    expect(t.f.calls.every((c) => c.startsWith("get:") || c.startsWith("watch:"))).toBe(true);
    expect(t.f.calls.every((c) => c.endsWith(USER))).toBe(true);
  });
});
