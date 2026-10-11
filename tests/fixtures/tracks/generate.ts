// Generates the replay fixtures in this folder (spec 15.2). Run: npx tsx tests/fixtures/tracks/generate.ts
// The JSON files are committed; this script documents how they were made.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { destinationPoint } from "../../../apps/server/src/risk/geometry.js";
import { formatRelativeTime } from "../../../apps/server/src/location/replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;

interface P {
  lat: number;
  lng: number;
}
interface F {
  t: string;
  lat: number;
  lng: number;
  accuracyM: number;
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** Stationary fixes at p from `fromMin` to `toMin` every `everySec`. */
function stay(p: P, fromMin: number, toMin: number, everySec = 60, accuracyM = 20): F[] {
  const out: F[] = [];
  for (let ms = fromMin * MIN; ms <= toMin * MIN; ms += everySec * 1000) out.push({ t: formatRelativeTime(ms), lat: round(p.lat), lng: round(p.lng), accuracyM });
  return out;
}

/** Straight-line travel from a to b, starting at `fromMin`, at `mps`, a fix every `everySec`. */
function travel(a: P, b: P, fromMin: number, mps: number, everySec = 60, accuracyM = 20): { fixes: F[]; endMin: number } {
  const dLat = b.lat - a.lat;
  const dLng = b.lng - a.lng;
  const distM = Math.hypot(dLat * 111_195, dLng * 111_195 * Math.cos((a.lat * Math.PI) / 180));
  const durS = distM / mps;
  const out: F[] = [];
  for (let s = everySec; s < durS; s += everySec) {
    const k = s / durS;
    out.push({ t: formatRelativeTime(fromMin * MIN + s * 1000), lat: round(a.lat + dLat * k), lng: round(a.lng + dLng * k), accuracyM });
  }
  return { fixes: out, endMin: fromMin + durS / 60 };
}

const venue = { lat: 41.9172, lng: -87.7067 }; // Lula Cafe area, Chicago
const home = { lat: 41.899, lng: -87.665 };
const noise = (seed: number, sigmaM = 30) => ({ sigmaM, outlierRate: 0.03, outlierM: 300, seed });

function write(name: string, track: Record<string, unknown>): void {
  writeFileSync(join(here, `${name}.json`), JSON.stringify({ name, ...track }, null, 2) + "\n");
}

// S-01: date, arrive, leave on time by car, text "home".
{
  const approach = travel(home, venue, -22, 9);
  const leave = travel(venue, home, 118, 10);
  write("date-normal", {
    description: "Date 2 h. Drives in, arrives at +00:00, stays, drives home at +01:58, texts home at +02:10.",
    venue,
    home,
    noise: noise(7),
    fixes: [...approach.fixes, ...stay(venue, 0, 118), ...leave.fixes],
    userMessages: [{ t: "+02:10", text: "home" }],
  });
}

// S-02 / S-03: date runs 40 min over at the venue.
{
  write("date-overtime", {
    description: "Date 2 h. Stays at the venue until +02:40 (40 min over). Replies +30 at +02:18, texts home at +02:55.",
    venue,
    home,
    noise: noise(11),
    fixes: [...stay(venue, -2, 160)],
    userMessages: [
      { t: "+02:18", text: "+30" },
      { t: "+02:55", text: "home" },
    ],
  });
}

// S-07: marketplace at a public spot, done in 15 min.
{
  const spot = { lat: 41.8789, lng: -87.6359 }; // public plaza
  write("marketplace-public", {
    description: "Marketplace 20 min at a public spot. Arrives at -00:02, done at +00:15.",
    venue: spot,
    noise: noise(3),
    fixes: stay(spot, -2, 15),
    userMessages: [{ t: "+00:15", text: "done" }],
  });
}

// S-08: marketplace at a private address, user leaves at vehicle speed 8 min in.
{
  const house = { lat: 41.9301, lng: -87.6895 };
  const away = destinationPoint(house.lat, house.lng, 6000, 200);
  const drive = travel(house, away, 8, 12);
  write("marketplace-private-car-departure", {
    description: "Marketplace 20 min at a private address. Arrives at -00:01, departs at 12 m/s at +00:08, never texts done.",
    venue: house,
    noise: noise(5, 15),
    fixes: [...stay(house, -1, 8), ...drive.fixes, ...stay(away, Math.ceil(drive.endMin), 40)],
    userMessages: [],
  });
}

// S-09: date, walks to a bar 400 m away, stays 30 min, answers "New spot?".
{
  const bar = destinationPoint(venue.lat, venue.lng, 400, 60);
  const walk = travel(venue, bar, 40, 1.3);
  const atBar = Math.ceil(walk.endMin);
  write("date-walk-to-bar", {
    description: "Date 2 h. At the venue until +00:40, walks 400 m to a bar, stays 30 min. Answers the New spot line, texts home at +02:10.",
    venue,
    home,
    noise: noise(9),
    fixes: [...stay(venue, -1, 40), ...walk.fixes, ...stay(bar, atBar, atBar + 30), ...stay(bar, atBar + 31, 118)],
    userMessages: [
      { t: "+00:58", text: "yeah we moved to the bar next door", label: "OK" },
      { t: "+02:10", text: "home" },
    ],
  });
}

// S-10: date, location goes dark for 12 min mid-date, then "phone died lol".
{
  write("date-dark", {
    description: "Date 2 h. Fixes every minute, none from +00:50 to +01:02 (12 min dark). Replies phone died lol at +01:03.",
    venue,
    home,
    noise: noise(13),
    fixes: [...stay(venue, -1, 50), ...stay(venue, 62, 118)],
    userMessages: [
      { t: "+01:03", text: "phone died lol", label: "OK" },
      { t: "+02:05", text: "home" },
    ],
  });
}

// S-11: viewing with indoor GPS drift up to 180 m.
{
  const flat = { lat: 41.9405, lng: -87.6545 };
  const fixes: F[] = [];
  for (let m = -2; m <= 40; m++) {
    const drift = 60 + 120 * Math.abs(Math.sin(m / 4)); // 60 to 180 m
    const p = destinationPoint(flat.lat, flat.lng, drift, (m * 47) % 360);
    fixes.push({ t: formatRelativeTime(m * MIN), lat: round(p.lat), lng: round(p.lng), accuracyM: 65 });
  }
  write("viewing-indoor-drift", {
    description: "Viewing 45 min. Indoor GPS drifts 60 to 180 m around the building with 65 m accuracy. Done at +00:40.",
    venue: flat,
    noise: { sigmaM: 20, outlierRate: 0.03, outlierM: 300, seed: 21 },
    fixes,
    userMessages: [{ t: "+00:40", text: "done" }],
  });
}

// S-17: no Find My share at all.
{
  write("no-share", {
    description: "Date 2 h. The user never accepts the Find My request. Replies +30 to the overtime check at +02:20, home at +02:40.",
    venue,
    share: { accepted: false },
    fixes: [],
    userMessages: [
      { t: "+02:20", text: "+30" },
      { t: "+02:40", text: "home" },
    ],
  });
}

console.log("tracks written to", here);
