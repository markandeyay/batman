import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fix } from "../../../apps/server/src/contracts.js";
import {
  ReplayLocationSource,
  formatRelativeTime,
  loadTrack,
  materializeTrack,
  mulberry32,
  parseRelativeTime,
  parseTrack,
} from "../../../apps/server/src/location/replay.js";
import {
  NoneLocationSource,
  acceptsFixInState,
  belongsToUser,
  createLocationSource,
  filterByExactAddress,
  guardedFixHandler,
} from "../../../apps/server/src/location/source.js";
import { haversineM } from "../../../apps/server/src/risk/geometry.js";
import { FakeClock } from "../../../apps/server/src/util/clock.js";
import { MIN, T0, at, fixAt } from "./helpers.js";

const TRACKS = join(import.meta.dirname, "../../fixtures/tracks");

describe("relative times (15.2)", () => {
  it("parses and formats", () => {
    expect(parseRelativeTime("-00:20")).toBe(-20 * MIN);
    expect(parseRelativeTime("+01:05")).toBe(65 * MIN);
    expect(parseRelativeTime("02:05")).toBe(125 * MIN);
    expect(parseRelativeTime("+00:01:30")).toBe(90_000);
    expect(() => parseRelativeTime("1h")).toThrow();
    expect(formatRelativeTime(-20 * MIN)).toBe("-00:20");
    expect(formatRelativeTime(90_000)).toBe("+00:01:30");
  });
});

describe("track format and fixtures", () => {
  it("accepts the spec example", () => {
    const t = parseTrack({
      name: "date-normal",
      venue: { lat: 41.9172, lng: -87.7067 },
      home: { lat: 41.899, lng: -87.665 },
      noise: { sigmaM: 30, outlierRate: 0.03, outlierM: 300, seed: 7 },
      fixes: [
        { t: "-00:20", lat: 41.9001, lng: -87.67, accuracyM: 15 },
        { t: "+00:01", lat: 41.9171, lng: -87.7066, accuracyM: 20 },
      ],
      userMessages: [{ t: "+02:05", text: "done" }],
    });
    expect(t.fixes).toHaveLength(2);
  });

  it("rejects malformed tracks", () => {
    expect(() => parseTrack({ name: "x", venue: { lat: 100, lng: 0 }, fixes: [] })).toThrow();
    expect(() => parseTrack({ name: "x", venue: { lat: 1, lng: 0 }, fixes: [{ t: "soon", lat: 1, lng: 1 }] })).toThrow();
  });

  it("every required fixture exists and parses", () => {
    const files = readdirSync(TRACKS).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(
      [
        "date-dark",
        "date-normal",
        "date-overtime",
        "date-walk-to-bar",
        "marketplace-private-car-departure",
        "marketplace-public",
        "no-share",
        "viewing-indoor-drift",
      ].map((n) => `${n}.json`),
    );
    for (const f of files) expect(loadTrack(join(TRACKS, f)).name).toBe(f.replace(".json", ""));
  });
});

describe("materializeTrack noise", () => {
  const track = loadTrack(join(TRACKS, "date-overtime.json"));

  it("is deterministic for a seed", () => {
    expect(materializeTrack(track, T0)).toEqual(materializeTrack(track, T0));
  });

  it("a different seed gives different noise", () => {
    const other = { ...track, noise: { ...track.noise!, seed: 99 } };
    expect(materializeTrack(other, T0).fixes[5]).not.toEqual(materializeTrack(track, T0).fixes[5]);
  });

  it("noise is roughly Gaussian with sigma 30 m and outliers about 3%", () => {
    const big = { ...track, fixes: Array.from({ length: 3000 }, (_, i) => ({ t: formatRelativeTime(i * 1000), lat: 41.9, lng: -87.7, accuracyM: 20 })) };
    const m = materializeTrack(big, T0);
    const d = m.fixes.map((f, i) => (m.outlierIndexes.includes(i) ? null : haversineM(f, { lat: 41.9, lng: -87.7 }))).filter((x): x is number => x !== null);
    const rms = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length);
    // 2D Gaussian with per-axis sigma 30: RMS radius = 30 * sqrt(2).
    expect(rms).toBeGreaterThan(38);
    expect(rms).toBeLessThan(47);
    expect(m.outlierIndexes.length / 3000).toBeGreaterThan(0.02);
    expect(m.outlierIndexes.length / 3000).toBeLessThan(0.04);
  });

  it("noise can be disabled", () => {
    const m = materializeTrack(track, T0, { noise: false });
    expect(m.fixes[0]).toMatchObject({ lat: track.fixes[0]!.lat, lng: track.fixes[0]!.lng, at: at(-2), source: "replay" });
  });

  it("resolves relative times and the share", () => {
    const ns = materializeTrack(loadTrack(join(TRACKS, "no-share.json")), T0);
    expect(ns.share.accepted).toBe(false);
    expect(ns.userMessages[0]).toEqual({ at: at(140), text: "+30" });
  });

  it("mulberry32 is stable", () => {
    const r = mulberry32(42);
    expect([r(), r()]).toEqual([mulberry32(42)(), (() => { const x = mulberry32(42); x(); return x(); })()]);
  });
});

describe("ReplayLocationSource honors the Clock", () => {
  const track = parseTrack({
    name: "t",
    venue: { lat: 41.9, lng: -87.7 },
    fixes: [
      { t: "-00:05", lat: 41.9, lng: -87.7 },
      { t: "+00:01", lat: 41.9, lng: -87.7 },
      { t: "+00:02", lat: 41.9, lng: -87.7 },
    ],
  });

  it("emits past fixes at once and future ones as the clock advances", async () => {
    const clock = new FakeClock(at(0));
    const got: Fix[] = [];
    const src = new ReplayLocationSource(track, { clock, startAt: T0 });
    await src.start("+13125550100", (f) => got.push(f));
    expect(got.map((f) => f.at)).toEqual([at(-5)]);
    await clock.advance(MIN);
    expect(got).toHaveLength(2);
    await src.stop();
    await clock.advance(5 * MIN);
    expect(got).toHaveLength(2);
  });

  it("I2: does nothing for an address other than the plan user's", async () => {
    const clock = new FakeClock(at(0));
    const got: Fix[] = [];
    const src = new ReplayLocationSource(track, { clock, startAt: T0, userAddress: "+13125550100" });
    await src.start("+13125550199", (f) => got.push(f));
    await clock.advance(10 * MIN);
    expect(got).toEqual([]);
  });

  it("a declined share emits nothing", async () => {
    const clock = new FakeClock(at(0));
    const got: Fix[] = [];
    await new ReplayLocationSource({ ...track, share: { accepted: false } }, { clock, startAt: T0 }).start("+1", (f) => got.push(f));
    await clock.advance(10 * MIN);
    expect(got).toEqual([]);
  });
});

describe("I2 / I3 helpers (S-21)", () => {
  it("filters list() results by the exact user address", () => {
    const entries = [
      { address: "+13125550100", latitude: 41.9 },
      { address: "+13125550199", latitude: 40.1 },
      { address: "+1 312 555 0100", latitude: 40.2 },
      { address: null, latitude: 40.3 },
      { latitude: 40.4 },
    ];
    expect(filterByExactAddress(entries, "+13125550100")).toEqual([{ address: "+13125550100", latitude: 41.9 }]);
    expect(filterByExactAddress([{ handle: "+13125550100" }], "+13125550100", (e) => e.handle)).toHaveLength(1);
    expect(belongsToUser("+13125550100", "+13125550100")).toBe(true);
    expect(belongsToUser("13125550100", "+13125550100")).toBe(false);
  });

  it("guarded handler drops other people's fixes and fixes outside a window", () => {
    let state: "ACTIVE" | "CLOSED" = "ACTIVE";
    const got: Fix[] = [];
    const h = guardedFixHandler("+13125550100", () => state, (f) => got.push(f));
    expect(h(fixAt(T0, 1, 1), "+13125550199")).toBe(false);
    expect(h(fixAt(T0, 1, 1), "+13125550100")).toBe(true);
    state = "CLOSED";
    expect(h(fixAt(T0, 1, 1), "+13125550100")).toBe(false);
    expect(got).toHaveLength(1);
    expect(acceptsFixInState("PRE_MEETUP")).toBe(true);
    expect(acceptsFixInState("ARMED")).toBe(false);
    expect(acceptsFixInState(null)).toBe(false);
  });

  it("createLocationSource wires by kind", () => {
    expect(createLocationSource("none", {})).toBeInstanceOf(NoneLocationSource);
    expect(() => createLocationSource("findmy", {})).toThrow();
    const fake = new NoneLocationSource();
    expect(createLocationSource("pin", { pin: () => fake })).toBe(fake);
  });
});
