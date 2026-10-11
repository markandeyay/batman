// Replay location source (spec 7.1, 15.2): JSON tracks with times relative to plan start,
// deterministic seeded Gaussian noise and outliers, emitted on the injected Clock (so the
// FakeClock and TIME_SCALE both apply).
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Clock, E164, Fix, LocationSource, ReplyLabel } from "../contracts.js";
import { destinationPoint } from "../risk/geometry.js";

const RelTime = z.string().regex(/^[+-]?\d{1,3}:\d{2}(:\d{2})?$/, "relative time like +01:05 or -00:20 or +00:01:30");

const LatLngSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export const TrackSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  venue: LatLngSchema,
  home: LatLngSchema.optional(),
  noise: z
    .object({
      sigmaM: z.number().min(0).default(0),
      outlierRate: z.number().min(0).max(1).default(0),
      outlierM: z.number().min(0).default(300),
      seed: z.number().int().default(1),
    })
    .optional(),
  /** Whether the user accepts the Find My request, and when the share expires (relative). */
  share: z.object({ accepted: z.boolean(), expiresAt: RelTime.optional() }).optional(),
  fixes: z.array(
    LatLngSchema.extend({
      t: RelTime,
      accuracyM: z.number().min(0).default(20),
      locationType: z.enum(["live", "shallow", "legacy", "unknown"]).optional(),
    }),
  ),
  /** Scripted user texts. `label` is the reply class a sim should use (no NLU in core sims). */
  userMessages: z.array(z.object({ t: RelTime, text: z.string(), label: z.enum(["OK", "NOT_OK", "AMBIGUOUS"]).optional() })).optional(),
});

export type Track = z.infer<typeof TrackSchema>;

/** "+01:05" -> 65 min in ms; "-00:20" -> -20 min; "+00:01:30" -> 90 s. */
export function parseRelativeTime(t: string): number {
  const m = /^([+-]?)(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) throw new Error(`bad relative time ${t}`);
  const sign = m[1] === "-" ? -1 : 1;
  const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000;
  return sign * ms;
}

export function formatRelativeTime(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  const total = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(h)}:${pad(m)}${s ? ":" + pad(s) : ""}`;
}

export function parseTrack(json: unknown): Track {
  return TrackSchema.parse(json);
}

export function loadTrack(path: string): Track {
  return parseTrack(JSON.parse(readFileSync(path, "utf8")));
}

/** mulberry32: small deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface MaterializedTrack {
  name: string;
  venue: { lat: number; lng: number };
  home: { lat: number; lng: number } | null;
  fixes: Fix[];
  userMessages: { at: Date; text: string; label?: ReplyLabel }[];
  share: { accepted: boolean; expiresAt: Date | null };
  /** Indexes of fixes that received an outlier displacement (for tests). */
  outlierIndexes: number[];
}

/**
 * Resolve relative times against `startAt` and apply noise deterministically from the seed.
 * The same track and start always produce identical fixes.
 */
export function materializeTrack(track: Track, startAt: Date, opts: { noise?: boolean } = {}): MaterializedTrack {
  const noise = track.noise;
  const useNoise = opts.noise !== false && !!noise && (noise.sigmaM > 0 || noise.outlierRate > 0);
  const rand = mulberry32(noise?.seed ?? 1);
  const outlierIndexes: number[] = [];
  const share = track.share ?? { accepted: true };
  const shareExpiresAt = share.expiresAt ? new Date(startAt.getTime() + parseRelativeTime(share.expiresAt)) : null;
  const sorted = [...track.fixes].sort((a, b) => parseRelativeTime(a.t) - parseRelativeTime(b.t));
  const fixes: Fix[] = sorted.map((f, i) => {
    let { lat, lng } = f;
    if (useNoise && noise) {
      // Draw a fixed number of values per fix so each fix's noise is independent of the others.
      const g1 = gaussian(rand);
      const g2 = gaussian(rand);
      const isOutlier = rand() < noise.outlierRate;
      const bearing = rand() * 360;
      const north = destinationPoint(lat, lng, Math.abs(g1 * noise.sigmaM), g1 >= 0 ? 0 : 180);
      const both = destinationPoint(north.lat, north.lng, Math.abs(g2 * noise.sigmaM), g2 >= 0 ? 90 : 270);
      lat = both.lat;
      lng = both.lng;
      if (isOutlier) {
        const o = destinationPoint(lat, lng, noise.outlierM, bearing);
        lat = o.lat;
        lng = o.lng;
        outlierIndexes.push(i);
      }
    }
    return {
      lat,
      lng,
      accuracyM: f.accuracyM,
      at: new Date(startAt.getTime() + parseRelativeTime(f.t)),
      locationType: "replay",
      expiresAt: shareExpiresAt,
      source: "replay",
    };
  });
  const userMessages = (track.userMessages ?? [])
    .map((m) => ({ at: new Date(startAt.getTime() + parseRelativeTime(m.t)), text: m.text, ...(m.label ? { label: m.label } : {}) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    name: track.name,
    venue: track.venue,
    home: track.home ?? null,
    fixes,
    userMessages,
    share: { accepted: share.accepted, expiresAt: shareExpiresAt },
    outlierIndexes,
  };
}

/**
 * LocationSource that plays a track on a Clock. Fixes whose time already passed when start()
 * is called are emitted at once (most recent `catchUpMs` only), the rest when the clock
 * reaches them. With a ScaledClock this honors TIME_SCALE; with a FakeClock, advance() drives it.
 */
export class ReplayLocationSource implements LocationSource {
  private stopped = false;
  private readonly catchUpMs: number;

  constructor(
    private readonly track: Track,
    private readonly opts: { clock: Clock; startAt: Date; userAddress?: E164; catchUpMs?: number },
  ) {
    this.catchUpMs = opts.catchUpMs ?? 15 * 60_000;
  }

  async start(userAddress: E164, onFix: (fix: Fix) => void): Promise<void> {
    if (this.opts.userAddress && this.opts.userAddress !== userAddress) return; // I2: only the plan's user
    this.stopped = false;
    const m = materializeTrack(this.track, this.opts.startAt);
    if (!m.share.accepted) return;
    const now = this.opts.clock.now().getTime();
    const pending: Fix[] = [];
    for (const f of m.fixes) {
      if (f.at.getTime() <= now) {
        if (now - f.at.getTime() <= this.catchUpMs) onFix(f);
      } else pending.push(f);
    }
    void this.play(pending, onFix);
  }

  private async play(pending: Fix[], onFix: (fix: Fix) => void): Promise<void> {
    for (const f of pending) {
      const wait = f.at.getTime() - this.opts.clock.now().getTime();
      if (wait > 0) await this.opts.clock.sleep(wait);
      if (this.stopped) return;
      onFix(f);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
