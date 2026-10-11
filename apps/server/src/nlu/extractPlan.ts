// Plan extraction (spec 9.2). The smart model returns PlanExtraction (schema exactly as 9.2);
// the start time is re-checked with chrono-node in the user's timezone. If chrono and the model
// disagree by more than 15 min, or only the model found a time, the time needs explicit
// confirmation. Never arm with an unconfirmed time. Without a model (no key, failure, timeout)
// a deterministic fallback extractor is used so intake keeps working.
import * as chrono from "chrono-node";
import { z } from "zod";
import type { PlanType } from "../contracts.js";
import { formatDayTime, offsetMinutes, wallTime, zonedWallTimeToUtc } from "../geo/timezone.js";
import type { LlmProvider } from "./llm.js";
import { loadPrompt } from "./prompts.js";

export const PlanExtraction = z.object({
  type: z.enum(["date", "marketplace", "viewing", "other"]).nullable(),
  startAtText: z.string().nullable(), // verbatim time phrase
  startAtISO: z.string().nullable(), // model's resolution; re-checked with chrono-node
  venueText: z.string().nullable(),
  durationMin: z.number().int().min(5).max(720).nullable(),
  counterpartName: z.string().max(60).nullable(),
  counterpartSource: z.string().max(40).nullable(),
  transport: z.enum(["self_drive", "rideshare", "transit", "walk", "their_car", "unknown"]).nullable(),
  firstTimeInPerson: z.boolean().nullable(),
  buyOrSell: z.enum(["buy", "sell"]).nullable(),
  meetingAtPrivateAddress: z.boolean().nullable(),
  userNervous: z.boolean(),
  wantsToChange: z.array(z.string()).max(5), // field names the user is editing
  confidence: z.number().min(0).max(1),
});
export type PlanExtraction = z.infer<typeof PlanExtraction>;

export const EXTRACT_TIMEOUT_MS = 15000;
/** Spec 9.2: disagreement above this needs confirmation. */
export const TIME_DISAGREE_MIN = 15;

export interface PartialPlanFacts {
  type?: PlanType | null;
  startAt?: Date | null;
  venueText?: string | null;
  durationMin?: number | null;
  counterpartName?: string | null;
  counterpartSource?: string | null;
  transport?: string | null;
}

export interface ExtractInput {
  messages: string[];
  partial?: PartialPlanFacts | null;
  now: Date;
  tz: string;
  /** The user's own display name. Never the counterpart (4.4.2). */
  userName?: string | null;
}

export interface ResolvedTime {
  /** Best start time (chrono when available, else the model's). null = no time given. */
  startAt: Date | null;
  chronoAt: Date | null;
  modelAt: Date | null;
  /** Ask the user to confirm (disagreement > 15 min, or only the model found a time). */
  needsConfirmation: boolean;
  /** The resolved time is in the past; propose `suggestedStart` (same time tomorrow). */
  inPast: boolean;
  suggestedStart: Date | null;
}

export interface ExtractOutcome {
  extraction: PlanExtraction;
  source: "model" | "fallback";
  time: ResolvedTime;
}

// ---------- chrono re-check ----------

function hasRelative(text: string): boolean {
  return /\b(in|within)\s+(an?|one|\d+|a few|a couple( of)?|half an?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i.test(text);
}

/**
 * A bare duration ("2 hours", "for 30 min", "30 min later") is never a start time: chrono reads
 * it as "now plus the duration", which turned "make it 2 hours" into a start time.
 */
const BARE_DURATION_RE =
  /^(?:for\s+)?(?:about\s+|around\s+)?(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|half an?|a few|a couple(?: of)?)\s*(?:hours?|hrs?|h|minutes?|mins?|m)(?:\s+(?:later|earlier|longer))?$/i;

/** "rn", "asap", "right now": now (chrono already handles a plain "now"). */
const NOW_WORDS_RE = /\b(rn|asap|right now|right away|now)\b/i;

/** True when the word at `index` is negated ("starts at 11 not now"). */
function negatedAt(text: string, index: number): boolean {
  return /\bnot\s*$/i.test(text.slice(0, index));
}

/**
 * Parse a time phrase in the user's timezone. Returns null when no clock time is certain
 * ("tonight" alone has no time). Bare hours without am/pm resolve to the next occurrence, or to
 * the evening for dates and hours 1 to 7 when a day was given.
 */
export function parseTimeInTz(text: string, now: Date, tz: string, type: PlanType | null = null): Date | null {
  if (!text.trim()) return null;
  const ref = { instant: now, timezone: offsetMinutes(now, tz) };
  const results = chrono.parse(text, ref, { forwardDate: true });
  for (const r of results) {
    if (BARE_DURATION_RE.test(r.text.trim())) continue;
    if (/^now$/i.test(r.text.trim()) && negatedAt(text, r.index)) continue;
    const s = r.start;
    if (hasRelative(r.text) || hasRelative(text)) {
      if (s.isCertain("hour") || s.isCertain("minute")) return s.date();
    }
    if (!s.isCertain("hour")) {
      // "noon" and "midnight" are certain in chrono; anything else without an hour is no time.
      continue;
    }
    let hour = s.get("hour") ?? 0;
    const minute = s.get("minute") ?? 0;
    const dayCertain = s.isCertain("day") || s.isCertain("weekday");
    const meridiemCertain = s.isCertain("meridiem") || hour === 0 || hour > 12 || /\b(noon|midnight|morning|evening|night|tonight|afternoon)\b/i.test(text);
    const local = wallTime(now, tz);
    let y = s.get("year") ?? local.year;
    let mo = s.get("month") ?? local.month;
    let d = s.get("day") ?? local.day;
    if (!meridiemCertain && hour >= 1 && hour <= 12) {
      const h12 = hour % 12;
      if (dayCertain) {
        const pm = (h12 >= 1 && h12 <= 7) || (type === "date" && h12 >= 8);
        hour = pm ? h12 + 12 : h12;
      } else {
        // Next occurrence among AM and PM, today or tomorrow, from 5 min ago.
        const floor = now.getTime() - 5 * 60000;
        const cands: Date[] = [];
        for (const dayOffset of [0, 1]) {
          for (const hh of [h12, h12 + 12]) {
            const base = zonedWallTimeToUtc({ year: local.year, month: local.month, day: local.day, hour: 12, minute: 0 }, tz);
            const w = wallTime(new Date(base.getTime() + dayOffset * 86400000), tz);
            cands.push(zonedWallTimeToUtc({ year: w.year, month: w.month, day: w.day, hour: hh, minute }, tz));
          }
        }
        const next = cands.filter((c) => c.getTime() >= floor).sort((a, b) => a.getTime() - b.getTime())[0];
        if (next) return next;
      }
    }
    if (!dayCertain && !s.isCertain("month")) {
      // Time only: today, or tomorrow when that time already passed (forwardDate semantics).
      const today = zonedWallTimeToUtc({ year: local.year, month: local.month, day: local.day, hour, minute }, tz);
      if (today.getTime() >= now.getTime() - 5 * 60000) return today;
      const t = wallTime(new Date(today.getTime() + 86400000), tz);
      y = t.year;
      mo = t.month;
      d = t.day;
    }
    return zonedWallTimeToUtc({ year: y, month: mo, day: d, hour, minute }, tz);
  }
  const nowWord = NOW_WORDS_RE.exec(text);
  if (nowWord && !negatedAt(text, nowWord.index)) return new Date(now);
  return null;
}

/** Combine model and chrono times per spec 9.2 and 4.4.5. */
export function resolveStartTime(
  e: Pick<PlanExtraction, "startAtText" | "startAtISO" | "type">,
  now: Date,
  tz: string,
): ResolvedTime {
  const chronoAt = parseTimeInTz(e.startAtText ?? "", now, tz, e.type);
  let modelAt: Date | null = null;
  if (e.startAtISO) {
    const d = new Date(e.startAtISO);
    if (!Number.isNaN(d.getTime())) modelAt = d;
  }
  let startAt: Date | null = null;
  let needsConfirmation = false;
  if (chronoAt && modelAt) {
    startAt = chronoAt;
    needsConfirmation = Math.abs(chronoAt.getTime() - modelAt.getTime()) > TIME_DISAGREE_MIN * 60000;
  } else if (chronoAt) {
    startAt = chronoAt;
  } else if (modelAt) {
    startAt = modelAt;
    needsConfirmation = true;
  }
  const inPast = startAt !== null && startAt.getTime() < now.getTime() - 5 * 60000;
  const suggestedStart = inPast && startAt ? nextDaySameTime(startAt, now) : null;
  return { startAt, chronoAt, modelAt, needsConfirmation, inPast, suggestedStart };
}

function nextDaySameTime(at: Date, now: Date): Date {
  let t = at.getTime();
  while (t < now.getTime()) t += 86400000;
  return new Date(t);
}

// ---------- counterpart post-check (4.4.2) ----------

const SELF_WORDS = new Set(["me", "i", "im", "myself", "self", "you", "us", "we", "mine", "yourself"]);

function firstName(s: string): string {
  return (s.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^\p{L}\p{M}'-]/gu, "");
}

/**
 * Deterministic post-check on any extracted counterpart: never the user's own display name
 * (case-insensitive, first-name match) and never "me" or "I". Returns the cleaned name or null.
 */
export function sanitizeCounterpart(name: string | null | undefined, userName: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const t = name.trim();
  if (!t) return null;
  const first = firstName(t);
  if (!first || SELF_WORDS.has(first)) return null;
  if (userName && userName.trim() && first === firstName(userName)) return null;
  return t;
}

// ---------- deterministic fallback extractor ----------

const SOURCES: Array<[RegExp, string]> = [
  [/\bhinge\b/i, "Hinge"],
  [/\btinder\b/i, "Tinder"],
  [/\bbumble\b/i, "Bumble"],
  [/\b(fb|facebook) ?market ?place\b/i, "Facebook Marketplace"],
  [/\bmarketplace\b/i, "Facebook Marketplace"],
  [/\bcraigslist\b/i, "Craigslist"],
  [/\bofferup\b/i, "OfferUp"],
  [/\bzillow\b/i, "Zillow"],
  [/\bfurnished finder\b/i, "Furnished Finder"],
  [/\bhinge|raya|feeld|grindr|her app\b/i, "dating app"],
];

const NOT_NAMES = new Set([
  "Hinge", "Tinder", "Bumble", "Marketplace", "Facebook", "Craigslist", "OfferUp", "Zillow", "Starbucks", "Target", "Walmart",
  "The", "A", "An", "My", "His", "Her", "Their", "Him", "Them", "Someone", "Somebody", "Tonight", "Today", "Tomorrow", "Saturday",
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Noon", "Lunch", "Dinner", "Coffee", "Drinks", "I", "Im",
  "Police", "Station", "Landlord", "Agent", "Guy", "Girl", "Seller", "Buyer",
]);

function inferType(t: string): PlanType | null {
  if (/\b(viewing|apartment|landlord|sublet|sublease|rental|lease|showing|tour(ing)? (an? )?(apt|apartment|unit|place|room|studio)|look(ing)? at (an? )?(apt|apartment|room|studio|unit)|room for rent|studio)\b/i.test(t)) return "viewing";
  if (/\b(marketplace|craigslist|offerup|selling|buying|sell(ing)? my|buy(ing)? (a|an|his|her|their|some)|pick(ing)? up (a|an|the|my)|pickup|couch|dresser|bike|item|listing|cash)\b/i.test(t)) return "marketplace";
  if (/\b(date|hinge|tinder|bumble|raya|first time meeting|drinks with|dinner with|coffee with|matched|match)\b/i.test(t)) return "date";
  if (/\b(meet(ing)?|meetup|hang(ing)? out)\b/i.test(t)) return "other";
  return null;
}

function inferTransport(t: string): PlanExtraction["transport"] {
  if (/\b(pick(ing)? me up|driving me|give me a ride|giving me a ride|in (his|her|their) car|ride with (him|her|them))\b/i.test(t)) return "their_car";
  if (/\b(uber|lyft|rideshare|ride share|taxi|cab|waymo)\b/i.test(t)) return "rideshare";
  if (/\b(bus|train|subway|metro|transit|the el|the l train|bart|muni|marta|septa)\b/i.test(t)) return "transit";
  if (/\b(walk|walking)\b/i.test(t)) return "walk";
  if (/\b(i'?ll drive|im driving|i'?m driving|driving myself|drive myself|driving there|my car|i'?m going to drive)\b/i.test(t)) return "self_drive";
  return null;
}

function inferDuration(t: string): number | null {
  const m =
    /\b(?:for|about|around|maybe|probably|like|takes?|should take|only|just|~)\s+(?:an?\s+)?(?:(\d+(?:\.\d+)?)|(an?|one|two|three|couple(?: of)?|few))\s*(hours?|hrs?|h|minutes?|mins?|min)\b/i.exec(t);
  if (!m) return null;
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, couple: 2, "couple of": 2, few: 3 };
  const n = m[1] ? Number(m[1]) : (words[m[2]!.toLowerCase()] ?? 1);
  const unit = m[3]!.toLowerCase();
  const min = /^h/.test(unit) ? n * 60 : n;
  const r = Math.round(min);
  return r >= 5 && r <= 720 ? r : null;
}

function inferVenue(t: string, timeText: string | null): string | null {
  const stripped = timeText ? t.replace(timeText, " ") : t;
  const re = /\b(?:at|@|to)\s+((?:the\s+)?[A-Z0-9][\w'&.-]*(?:\s+(?:[A-Z0-9][\w'&.-]*|on|of|and|the|de|at)){0,6}(?:,\s*\d+[^,.!?]*)?)/g;
  for (const m of stripped.matchAll(re)) {
    const v = m[1]!.trim().replace(/\s+(on|of|and|the|at)$/i, "");
    if (/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(v)) continue;
    if (/^(noon|midnight|tonight|today|tomorrow|night)$/i.test(v)) continue;
    if (v.length < 2) continue;
    return v;
  }
  const priv = /\b((?:his|her|their|my) (?:place|apartment|apt|house|condo))\b/i.exec(t);
  if (priv) return priv[1]!;
  return null;
}

function inferCounterpart(t: string): string | null {
  const m = /\b(?:with|meeting|meet|named|called)\s+([A-Z][a-z]{1,20})\b/.exec(t);
  if (!m) return null;
  return NOT_NAMES.has(m[1]!) ? null : m[1]!;
}

/** Deterministic extraction used when no model is available or it fails. */
export function fallbackExtract(messages: string[], now: Date, tz: string, opts: { userName?: string | null } = {}): PlanExtraction {
  const t = messages.join("\n");
  const type = inferType(t);
  const ref = { instant: now, timezone: offsetMinutes(now, tz) };
  const parsed = chrono
    .parse(t, ref, { forwardDate: true })
    .find((r) => !BARE_DURATION_RE.test(r.text.trim()) && (r.start.isCertain("hour") || hasRelative(r.text)));
  const nowWord = NOW_WORDS_RE.exec(t);
  const startAtText = parsed ? parsed.text : nowWord && !negatedAt(t, nowWord.index) ? nowWord[0] : null;
  let source: string | null = null;
  for (const [re, name] of SOURCES) {
    if (re.test(t)) {
      source = name;
      break;
    }
  }
  const editing = /^(actually|change|make it|instead|move it|moved it|now it'?s|update|switch)/i.test(t.trim());
  const venueText = inferVenue(t, startAtText);
  const wantsToChange: string[] = [];
  if (editing) {
    if (startAtText) wantsToChange.push("startAt");
    if (venueText) wantsToChange.push("venueText");
  }
  return {
    type,
    startAtText,
    startAtISO: null,
    venueText,
    durationMin: inferDuration(t),
    counterpartName: sanitizeCounterpart(inferCounterpart(t), opts.userName),
    counterpartSource: source,
    transport: inferTransport(t),
    firstTimeInPerson: /\b(first date|first time meeting|never met|meeting for the first time|first time in person)\b/i.test(t)
      ? true
      : /\b(met before|second date|third date|met (him|her|them) before)\b/i.test(t)
        ? false
        : null,
    buyOrSell: /\b(selling|sell)\b/i.test(t) ? "sell" : /\b(buying|buy|pick(ing)? up)\b/i.test(t) ? "buy" : null,
    meetingAtPrivateAddress: /\b(his|her|their|my) (place|apartment|apt|house|condo|home)\b/i.test(t) ? true : null,
    userNervous: /\b(nervous|anxious|scared|worried|uneasy|sketched out)\b/i.test(t),
    wantsToChange,
    confidence: 0.5,
  };
}

// ---------- model call ----------

function describeNow(now: Date, tz: string): string {
  const off = offsetMinutes(now, tz);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const w = wallTime(now, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)} (${formatDayTime(now, tz)})`;
}

export async function extractPlan(input: ExtractInput, llm: LlmProvider | null, opts: { timeoutMs?: number } = {}): Promise<ExtractOutcome> {
  let extraction: PlanExtraction | null = null;
  let source: ExtractOutcome["source"] = "fallback";
  if (llm) {
    try {
      const partial = input.partial
        ? { ...input.partial, startAt: input.partial.startAt ? input.partial.startAt.toISOString() : null }
        : {};
      extraction = await llm.parse({
        task: "extractPlan",
        tier: "smart",
        effort: "low",
        system: loadPrompt("extractPlan"),
        user: JSON.stringify({
          now: describeNow(input.now, input.tz),
          timezone: input.tz,
          userName: input.userName ?? null,
          currentPlan: partial,
          messages: input.messages,
        }),
        schema: PlanExtraction,
        timeoutMs: opts.timeoutMs ?? EXTRACT_TIMEOUT_MS,
        maxTokens: 1500,
      });
      source = "model";
    } catch {
      extraction = null;
    }
  }
  if (!extraction) extraction = fallbackExtract(input.messages, input.now, input.tz, { userName: input.userName ?? null });
  else extraction = { ...extraction, counterpartName: sanitizeCounterpart(extraction.counterpartName, input.userName) };
  const time = resolveStartTime(extraction, input.now, input.tz);
  return { extraction, source, time };
}
