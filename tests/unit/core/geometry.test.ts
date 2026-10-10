import { describe, expect, it } from "vitest";
import {
  coarsenCoord,
  destinationPoint,
  detectArrival,
  detectDeparture,
  detectStay,
  haversineM,
  isDark,
  isNightHours,
  isUsableFix,
  isVehicleSpeed,
  latestUsableFix,
  recentSegmentSpeeds,
  venueRadiusM,
  zoneOf,
} from "../../../apps/server/src/risk/geometry.js";
import { T0, VENUE, at, fixAt, fixFromVenue } from "./helpers.js";

const sec = (s: number) => new Date(T0.getTime() + s * 1000);

describe("haversine and destinationPoint", () => {
  it("measures known distances", () => {
    // 1 degree of latitude is about 111.2 km.
    expect(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -2);
    expect(haversineM(VENUE, VENUE)).toBe(0);
  });

  it("destinationPoint round-trips through haversine", () => {
    for (const m of [10, 120, 400, 5000]) {
      const p = destinationPoint(VENUE.lat, VENUE.lng, m, 37);
      expect(haversineM(VENUE, p)).toBeCloseTo(m, 3);
    }
  });
});

describe("usable fix (7.2)", () => {
  it("requires accuracy <= 200 m, coordinates, and age <= 10 min", () => {
    expect(isUsableFix(fixAt(T0, 1, 1, 200), T0)).toBe(true);
    expect(isUsableFix(fixAt(T0, 1, 1, 201), T0)).toBe(false);
    expect(isUsableFix(fixAt(at(-10), 1, 1), T0)).toBe(true);
    expect(isUsableFix(fixAt(at(-10.1), 1, 1), T0)).toBe(false);
    expect(isUsableFix(fixAt(T0, Number.NaN, 1), T0)).toBe(false);
    expect(isUsableFix(fixAt(T0, 91, 1), T0)).toBe(false);
  });

  it("latestUsableFix skips stale and inaccurate fixes", () => {
    const fixes = [fixAt(at(-2), 1, 1, 20), fixAt(at(-1), 2, 2, 500), fixAt(at(-30), 3, 3, 10)];
    expect(latestUsableFix(fixes, T0)?.lat).toBe(1);
  });
});

describe("geofence radius and hysteresis", () => {
  it("uses base radius by type and 2x accuracy when larger", () => {
    expect(venueRadiusM("date", 20)).toBe(120);
    expect(venueRadiusM("other", 20)).toBe(120);
    expect(venueRadiusM("marketplace", 20)).toBe(150);
    expect(venueRadiusM("viewing", 20)).toBe(250);
    expect(venueRadiusM("date", 100)).toBe(200);
  });

  it("classifies inside, band, outside at the edges", () => {
    expect(zoneOf(fixFromVenue(T0, 119), VENUE, 120)).toBe("inside");
    expect(zoneOf(fixFromVenue(T0, 121), VENUE, 120)).toBe("band");
    expect(zoneOf(fixFromVenue(T0, 179), VENUE, 120)).toBe("band");
    expect(zoneOf(fixFromVenue(T0, 181), VENUE, 120)).toBe("outside");
    // Poor accuracy widens the radius: 90 m accuracy -> 180 m radius.
    expect(zoneOf(fixFromVenue(T0, 170, 90, 90), VENUE, 120)).toBe("inside");
  });
});

describe("arrival (2 inside, >= 45 s apart)", () => {
  it("detects on the second inside fix 45 s after the first", () => {
    const fixes = [fixFromVenue(sec(0), 500), fixFromVenue(sec(30), 50), fixFromVenue(sec(60), 40), fixFromVenue(sec(75), 30)];
    expect(detectArrival(fixes, VENUE, 120)?.getTime()).toBe(sec(75).getTime());
  });

  it("does not detect with fixes less than 45 s apart", () => {
    expect(detectArrival([fixFromVenue(sec(0), 50), fixFromVenue(sec(44), 50)], VENUE, 120)).toBeNull();
  });

  it("an outside fix breaks the run", () => {
    expect(detectArrival([fixFromVenue(sec(0), 50), fixFromVenue(sec(30), 400), fixFromVenue(sec(60), 50)], VENUE, 120)).toBeNull();
  });

  it("ignores inaccurate fixes", () => {
    expect(detectArrival([fixFromVenue(sec(0), 50), fixFromVenue(sec(60), 50, 90, 300)], VENUE, 120)).toBeNull();
  });
});

describe("departure (2 outside, >= 60 s apart, after inside)", () => {
  const inside = [fixFromVenue(sec(0), 20), fixFromVenue(sec(60), 20)];

  it("detects a confirmed departure", () => {
    const fixes = [...inside, fixFromVenue(sec(120), 300), fixFromVenue(sec(180), 500)];
    expect(detectDeparture(fixes, VENUE, 120, sec(180))).toEqual({ leftAt: sec(120), confirmedAt: sec(180) });
  });

  it("needs the outside run to span 60 s", () => {
    const fixes = [...inside, fixFromVenue(sec(120), 300), fixFromVenue(sec(150), 500)];
    expect(detectDeparture(fixes, VENUE, 120, sec(150))).toBeNull();
  });

  it("a single outlier is not a departure", () => {
    const fixes = [...inside, fixFromVenue(sec(120), 400), fixFromVenue(sec(180), 20)];
    expect(detectDeparture(fixes, VENUE, 120, sec(180))).toBeNull();
  });

  it("requires a prior inside fix", () => {
    const fixes = [fixFromVenue(sec(0), 400), fixFromVenue(sec(60), 500), fixFromVenue(sec(120), 600)];
    expect(detectDeparture(fixes, VENUE, 120, sec(120))).toBeNull();
  });

  it("band fixes do not count as outside", () => {
    const fixes = [...inside, fixFromVenue(sec(120), 150), fixFromVenue(sec(180), 160)];
    expect(detectDeparture(fixes, VENUE, 120, sec(180))).toBeNull();
  });

  it("stale confirming fix is ignored", () => {
    const fixes = [...inside, fixFromVenue(sec(120), 300), fixFromVenue(sec(180), 500)];
    expect(detectDeparture(fixes, VENUE, 120, sec(180 + 11 * 60))).toBeNull();
  });
});

describe("speed (segments >= 60 s apart)", () => {
  it("computes speeds over >= 60 s segments, skipping closer fixes", () => {
    const fixes = [fixFromVenue(sec(0), 0), fixFromVenue(sec(30), 100), fixFromVenue(sec(60), 600), fixFromVenue(sec(120), 1200)];
    const s = recentSegmentSpeeds(fixes, 2);
    expect(s[0]).toBeCloseTo(10, 0);
    expect(s[1]).toBeCloseTo(10, 0);
    expect(isVehicleSpeed(fixes)).toBe(true);
  });

  it("walking pace is not vehicle speed", () => {
    const fixes = [0, 60, 120, 180].map((s, i) => fixFromVenue(sec(s), i * 80));
    expect(isVehicleSpeed(fixes)).toBe(false);
  });

  it("needs two fast segments, not one", () => {
    const fixes = [fixFromVenue(sec(0), 0), fixFromVenue(sec(60), 50), fixFromVenue(sec(120), 700)];
    expect(isVehicleSpeed(fixes)).toBe(false);
  });

  it("exactly 7 m/s counts", () => {
    const fixes = [0, 60, 120].map((s, i) => fixFromVenue(sec(s), i * 420));
    expect(isVehicleSpeed(fixes)).toBe(true);
  });
});

describe("dark (10 min without a usable fix)", () => {
  it("is dark 10 min after the last usable fix", () => {
    const fixes = [fixFromVenue(at(0), 10)];
    expect(isDark(fixes, at(9.9), at(-5))).toBe(false);
    expect(isDark(fixes, at(10), at(-5))).toBe(true);
  });

  it("counts from the reference when there were no fixes", () => {
    expect(isDark([], at(9), at(0))).toBe(false);
    expect(isDark([], at(10), at(0))).toBe(true);
  });

  it("inaccurate fixes do not keep it lit", () => {
    expect(isDark([fixFromVenue(at(9), 10, 90, 500)], at(10), at(0))).toBe(true);
  });
});

describe("stay at a new spot (T-VENUE-CHG geometry)", () => {
  const bar = destinationPoint(VENUE.lat, VENUE.lng, 400, 45);
  it("detects a 10+ min stay away from the venue", () => {
    const fixes = [fixFromVenue(at(0), 10), ...Array.from({ length: 13 }, (_, i) => fixAt(at(5 + i), bar.lat, bar.lng))];
    const stay = detectStay(fixes, at(17), VENUE, 120);
    expect(stay).not.toBeNull();
    expect(haversineM(stay!.center, bar)).toBeLessThan(5);
  });

  it("does not detect while still moving", () => {
    const fixes = Array.from({ length: 15 }, (_, i) => fixFromVenue(at(i), 200 + i * 150));
    expect(detectStay(fixes, at(14), VENUE, 120)).toBeNull();
  });

  it("does not detect a stay shorter than 10 min", () => {
    const fixes = [fixFromVenue(at(0), 10), ...Array.from({ length: 6 }, (_, i) => fixAt(at(5 + i), bar.lat, bar.lng))];
    expect(detectStay(fixes, at(10), VENUE, 120)).toBeNull();
  });
});

describe("home and night", () => {
  it("coarsens home coordinates to 3 decimals", () => {
    expect(coarsenCoord(41.91729)).toBe(41.917);
  });

  it("night is 22:00 to 05:00 local", () => {
    const tz = "America/New_York";
    expect(isNightHours(new Date("2026-10-11T01:59:00Z"), tz)).toBe(false); // 21:59 EDT
    expect(isNightHours(new Date("2026-10-11T02:00:00Z"), tz)).toBe(true); // 22:00
    expect(isNightHours(new Date("2026-10-11T08:59:00Z"), tz)).toBe(true); // 04:59
    expect(isNightHours(new Date("2026-10-11T09:00:00Z"), tz)).toBe(false); // 05:00
  });
});
