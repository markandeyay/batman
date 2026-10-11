// Logging (spec 8.1): pino JSON to stdout and logs/batman.log.
// Phone numbers are redacted to the last 4 digits everywhere. Coordinates are dropped at info and above.
// Keys that look like secrets are always replaced.
import fs from "node:fs";
import path from "node:path";
import pino, { type Logger } from "pino";

const PHONE_RE = /\+?\(?\d[\d\s\-().]{8,}\d/g;
const COORD_KEYS = new Set(["lat", "lng", "latitude", "longitude", "venueLat", "venueLng", "homeLat", "homeLng"]);
const SECRET_KEY_RE = /secret|token|password|apikey|api_key|authorization/i;

/** Replace any phone-number-looking run of 7+ digits with ***1234. */
export function redactPhones(s: string): string {
  return s.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 7 ? `***${digits.slice(-4)}` : m;
  });
}

/** Deep-clean a log argument. Exported for tests. */
/** L1: maps links and coordinate pairs inside free text (alert bodies, error messages). */
const MAPS_URL_RE = /https?:\/\/(?:[\w-]+\.)*(?:maps\.apple\.com|maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)\S*/gi;
const COORD_PAIR_RE = /-?\d{1,3}\.\d{3,}\s*(?:,|%2C)\s*-?\d{1,3}\.\d{3,}/gi;

export function scrubCoordinates(s: string): string {
  return s.replace(MAPS_URL_RE, "[maps link]").replace(COORD_PAIR_RE, "[loc]");
}

function cleanString(s: string, dropCoords: boolean): string {
  const r = redactPhones(s);
  return dropCoords ? scrubCoordinates(r) : r;
}

export function scrub(value: unknown, dropCoords: boolean, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return cleanString(value, dropCoords);
  if (value instanceof Error) return { name: value.name, message: cleanString(value.message, dropCoords) };
  if (Array.isArray(value)) return value.map((v) => scrub(v, dropCoords, depth + 1));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (dropCoords && COORD_KEYS.has(k)) continue;
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : scrub(v, dropCoords, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(opts: { level: string; logDir?: string; name?: string }): Logger {
  const level = opts.level as pino.LevelWithSilent;
  const streams: pino.StreamEntry[] = [{ level: level === "silent" ? "fatal" : level, stream: process.stdout }];
  if (opts.logDir) {
    fs.mkdirSync(opts.logDir, { recursive: true });
    streams.push({
      level: level === "silent" ? "fatal" : level,
      stream: pino.destination({ dest: path.join(opts.logDir, "batman.log"), sync: false, mkdir: true }),
    });
  }
  return pino(
    {
      name: opts.name ?? "batman",
      level,
      hooks: {
        logMethod(args, method, lvl) {
          const dropCoords = lvl >= 30; // info and above
          const cleaned = args.map((a) => scrub(a, dropCoords)) as Parameters<typeof method>;
          return method.apply(this, cleaned);
        },
      },
    },
    pino.multistream(streams),
  );
}

export type { Logger };
