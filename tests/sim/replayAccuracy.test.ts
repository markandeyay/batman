// Spec 7.5 accuracy target: arrival and departure are detected within 3 fixes of the true
// transition in replay tracks with realistic noise (30 m Gaussian, occasional 300 m outliers).
// Seeded tracks per meetup type and travel mode, a fix every 60 s; deterministic, so any miss
// reproduces from its seed. The true transition is the first fix whose noise-free position is
// inside (arrival) or outside (departure) the venue radius.
//
// Findings (X1, 7.2 refinement: outlier rejection plus a 60 m cap on the hysteresis band):
// - Gaussian noise alone: every type and travel mode, including slow walkers leaving a 250 m
//   viewing geofence, is within 3 fixes.
// - With 3% 300 m outliers: departures and arrivals are within 3 fixes in at least 98.7% of
//   tracks (was 94.7%). The remaining date misses (seed 82: two consecutive outliers that agree
//   with each other fake a departure; seed 118: an outlier just inside the jump threshold delays
//   arrival to 4 fixes) are the documented gap in the it.fails below.
import { describe, expect, it } from "vitest";
import type { Fix, PlanType } from "../../apps/server/src/contracts.js";
import { formatRelativeTime, materializeTrack, parseTrack } from "../../apps/server/src/location/replay.js";
import { destinationPoint, detectArrival, detectDeparture, haversineM, venueBaseRadiusM } from "../../apps/server/src/risk/geometry.js";

const START = new Date("2026-10-10T23:00:00Z");
const VENUE = { lat: 41.9172, lng: -87.7067 };
const SEEDS = 150;
const WALK = 1.4;
const DRIVE = 9;

interface Noise {
  sigmaM: number;
  outlierRate: number;
  outlierM: number;
}
const SPEC_NOISE: Noise = { sigmaM: 30, outlierRate: 0.03, outlierM: 300 };
const GAUSSIAN_ONLY: Noise = { sigmaM: 30, outlierRate: 0, outlierM: 300 };

interface Truth {
  fixes: Fix[];
  outliers: number;
  arrivalIdx: number;
  departureIdx: number;
}

/** Approach from 1.5 km, stay 40 min, leave on another bearing for 3 km. */
function track(type: PlanType, mps: number, seed: number, noise: Noise): Truth {
  const radius = venueBaseRadiusM(type);
  const pts: { lat: number; lng: number }[] = [];
  const inBearing = (seed * 37) % 360;
  const outBearing = (inBearing + 90 + ((seed * 53) % 180)) % 360;
  const step = mps * 60;
  for (let d = 1500; d > 0; d -= step) pts.push(destinationPoint(VENUE.lat, VENUE.lng, d, inBearing));
  for (let i = 0; i < 40; i++) pts.push(destinationPoint(VENUE.lat, VENUE.lng, (i * 7) % 15, (i * 97) % 360)); // fidgeting
  for (let d = step; d <= 3000; d += step) pts.push(destinationPoint(VENUE.lat, VENUE.lng, d, outBearing));
  const dist = pts.map((p) => haversineM(p, VENUE));
  const arrivalIdx = dist.findIndex((d) => d <= radius);
  const departureIdx = dist.findIndex((d, i) => i > arrivalIdx && d > radius);
  const raw = parseTrack({
    name: `acc-${type}-${mps}-${seed}`,
    venue: VENUE,
    noise: { ...noise, seed },
    fixes: pts.map((p, i) => ({ t: formatRelativeTime(i * 60_000), lat: p.lat, lng: p.lng, accuracyM: 20 })),
  });
  const m = materializeTrack(raw, START);
  return { fixes: m.fixes, outliers: m.outlierIndexes.length, arrivalIdx, departureIdx };
}

interface Outcome {
  seed: number;
  arrivalOff: number | null;
  departureOff: number | null;
}

/** Feed fixes one at a time; offset = detecting fix index minus the true transition index. */
function measure(type: PlanType, mps: number, noise: Noise): { outcomes: Outcome[]; outliers: number } {
  const base = venueBaseRadiusM(type);
  const outcomes: Outcome[] = [];
  let outliers = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const t = track(type, mps, seed, noise);
    outliers += t.outliers;
    let arr = -1;
    for (let k = 0; k < t.fixes.length && arr < 0; k++) if (detectArrival(t.fixes.slice(0, k + 1), VENUE, base)) arr = k;
    let dep = -1;
    for (let k = arr + 1; arr >= 0 && k < t.fixes.length && dep < 0; k++) if (detectDeparture(t.fixes.slice(0, k + 1), VENUE, base, t.fixes[k]!.at)) dep = k;
    outcomes.push({ seed, arrivalOff: arr < 0 ? null : arr - t.arrivalIdx, departureOff: dep < 0 ? null : dep - t.departureIdx });
  }
  return { outcomes, outliers };
}

const within3 = (off: number | null) => off !== null && Math.abs(off) <= 3;
const misses = (o: Outcome[]) =>
  o.flatMap((x) => [
    ...(within3(x.arrivalOff) ? [] : [`seed ${x.seed} arrival ${x.arrivalOff}`]),
    ...(within3(x.departureOff) ? [] : [`seed ${x.seed} departure ${x.departureOff}`]),
  ]);

const ALL: [PlanType, string, number][] = [
  ["date", "walking", WALK],
  ["date", "driving", DRIVE],
  ["marketplace", "walking", WALK],
  ["marketplace", "driving", DRIVE],
  ["viewing", "walking", WALK],
  ["viewing", "driving", DRIVE],
];

describe("7.5 arrival and departure within 3 fixes", () => {
  it.each(ALL)(
    "%s, %s, 30 m Gaussian noise: every seeded track within 3 fixes",
    (type, _m, mps) => {
      expect(misses(measure(type, mps, GAUSSIAN_ONLY).outcomes)).toEqual([]);
    },
  );

  it.each(ALL)("%s, %s, spec noise (30 m plus 3 percent 300 m outliers): at least 98 percent of tracks within 3 fixes (regression guard), no early arrival", (type, _m, mps) => {
    const { outcomes, outliers } = measure(type, mps, SPEC_NOISE);
    expect(outliers, "outliers are present").toBeGreaterThan(0);
    const arrOk = outcomes.filter((o) => within3(o.arrivalOff)).length / outcomes.length;
    const depOk = outcomes.filter((o) => within3(o.departureOff)).length / outcomes.length;
    // Guard at the measured worst case after X1 (marketplace walking, 98.7% departures).
    expect(arrOk).toBeGreaterThanOrEqual(0.98);
    expect(depOk).toBeGreaterThanOrEqual(0.98);
    // Arrival is never declared before the user is near the venue.
    expect(outcomes.every((o) => o.arrivalOff !== null && o.arrivalOff >= -1)).toBe(true);
  });

  // Known gaps against the strict 7.5 wording. These pass while the gap exists; if detection is
  // improved they start failing, and should become plain `it` tests.
  it.fails("strict target, spec noise: every date track within 3 fixes (fails: 2 of 150 seeds, see findings)", () => {
    expect(misses(measure("date", WALK, SPEC_NOISE).outcomes)).toEqual([]);
  });
  it("strict target, Gaussian only: viewing walkers leave within 3 fixes (X1: hysteresis band capped at 60 m)", () => {
    expect(misses(measure("viewing", WALK, GAUSSIAN_ONLY).outcomes)).toEqual([]);
  });

  it("the replay noise is what the spec describes: ~3% outliers, ~30 m per-axis scatter", () => {
    let fixes = 0;
    let outliers = 0;
    const errs: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const raw = parseTrack({
        name: "noise",
        venue: VENUE,
        noise: { ...SPEC_NOISE, seed },
        fixes: Array.from({ length: 100 }, (_, i) => ({ t: formatRelativeTime(i * 60_000), lat: VENUE.lat, lng: VENUE.lng, accuracyM: 20 })),
      });
      const m = materializeTrack(raw, START);
      fixes += m.fixes.length;
      outliers += m.outlierIndexes.length;
      m.fixes.forEach((f, i) => {
        if (!m.outlierIndexes.includes(i)) errs.push(haversineM(f, VENUE));
      });
    }
    expect(outliers / fixes).toBeGreaterThan(0.015);
    expect(outliers / fixes).toBeLessThan(0.045);
    const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
    expect(rms).toBeGreaterThan(35); // two 30 m axes give about 42 m RMS
    expect(rms).toBeLessThan(50);
  });
});
