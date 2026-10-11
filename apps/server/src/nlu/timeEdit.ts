// Deterministic plan-edit detection (spec 4.4.6, 9.2). Runs before any model call when the user
// replies to a plan confirmation or edits an armed plan: chrono-node in the user's timezone
// first, plus small rules for shifts ("push it 30 min") and durations ("make it 2 hours").
// The model extractor is only consulted when this finds nothing.
import type { PlanType } from "../contracts.js";
import { wallTime } from "../geo/timezone.js";
import { parseTimeInTz } from "./extractPlan.js";

export interface EditContext {
  now: Date;
  tz: string;
  type: PlanType | null;
  /** The plan's current start, for relative shifts. */
  startAt: Date | null;
}

export type TimeEdit = { kind: "at"; at: Date } | { kind: "choice"; options: [Date, Date] };

export interface DetectedEdit {
  time: TimeEdit | null;
  durationMin: number | null;
}

const MIN = 60_000;
const QTY = String.raw`(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|half an?|a couple(?: of)?|a few)`;
const UNIT = String.raw`(hours?|hrs?|h|minutes?|mins?|min)`;
const QTY_UNIT = new RegExp(String.raw`\b${QTY}\s*${UNIT}\b`, "i");
const NUM_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  "half a": 0.5,
  "half an": 0.5,
  "a couple": 2,
  "a couple of": 2,
  "a few": 3,
};

function toMinutes(qty: string, unit: string): number {
  const q = qty.toLowerCase().replace(/\s+/g, " ");
  const n = /^\d/.test(q) ? Number(q) : (NUM_WORDS[q] ?? 1);
  return Math.round(/^h/i.test(unit) ? n * 60 : n);
}

const SHIFT_VERB = /\b(push|pushed|pushing|move|moved|moving|bump|bumped|delay|delayed|shift|shifted|slide|slid)\b/i;
const EARLIER = /\b(earlier|sooner)\b|\b(move|moved|bump|bumped|push|pushed)\s+(it\s+|that\s+)?(up|forward)\b/i;
const RELATIVE_AFTER = /^\s*(later|earlier|sooner|from now|ago|before|after|back)\b/i;
const MERIDIEM = /\b(am|pm|a\.m\.?|p\.m\.?|noon|midnight|morning|evening|night|tonight|afternoon|lunch|dinner|breakfast)\b|\d\s*(a|p)m?\b/i;
const DAY_WORD =
  /\b(today|tomorrow|tmrw|tmr|tonight|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|weekend)\b/i;
const RELATIVE_TIME = /\b(in|within)\s+\S+|\bfrom now\b|\bnow\b|\brn\b|\basap\b/i;
/** A clock number on its own at the end ("change the time to 11", "make it 11:30", "11"). */
const BARE_CLOCK =
  /(?:^|\b(?:to|at|for|make it|it'?s|its|now|actually|starts?|start at|instead|maybe|more like))\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.?|p\.m\.?|a|p)?\s*(?:instead|then|pls|please|ok|okay)?\s*[.!,]*\s*$/i;

/** A relative shift of the current start ("push it 30 min", "an hour later", "move it up 15"). */
function detectShift(text: string, startAt: Date | null): Date | null {
  if (!startAt) return null;
  const m = QTY_UNIT.exec(text);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const laterWord = /^\s*(later|earlier|sooner|back)\b/i.test(after);
  if (!SHIFT_VERB.test(text) && !laterWord) return null;
  if (/^\s*from now\b/i.test(after)) return null; // "an hour from now" is a time, not a shift
  const min = toMinutes(m[1]!, m[2]!);
  if (min <= 0 || min > 720) return null;
  const sign = EARLIER.test(text) ? -1 : 1;
  return new Date(startAt.getTime() + sign * min * MIN);
}

/** A new duration ("make it 2 hours", "for 45 min", "half an hour"). Never a relative time. */
function detectDuration(text: string): number | null {
  if (SHIFT_VERB.test(text)) return null;
  const m = QTY_UNIT.exec(text);
  if (!m) return null;
  const before = text.slice(0, m.index);
  if (/\b(in|within)\s*$/i.test(before)) return null;
  if (RELATIVE_AFTER.test(text.slice(m.index + m[0].length))) return null;
  const min = toMinutes(m[1]!, m[2]!);
  return min >= 5 && min <= 720 ? min : null;
}

function detectClock(text: string, ctx: EditContext): Date | null {
  const t = parseTimeInTz(text, ctx.now, ctx.tz, ctx.type);
  if (t) return t;
  const m = BARE_CLOCK.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  const mer = m[3] ? (m[3].toLowerCase().startsWith("a") ? "am" : "pm") : "";
  return parseTimeInTz(`at ${h}${m[2] ? ":" + m[2] : ""}${mer}`, ctx.now, ctx.tz, ctx.type);
}

/**
 * A bare hour with no am/pm and no day that lands between midnight and 8 AM is ambiguous: "2"
 * at 10:54 PM is 2 AM or 2 PM. Offer both (12 h apart) instead of guessing.
 */
function ambiguous(text: string, at: Date, tz: string): boolean {
  if (MERIDIEM.test(text) || DAY_WORD.test(text) || RELATIVE_TIME.test(text)) return false;
  const num = /\b(\d{1,2})(?::\d{2})?\b/.exec(text);
  if (!num || Number(num[1]) > 12) return false;
  return wallTime(at, tz).hour < 8;
}

const EDIT_FILLER = new Set(
  (
    "actually make made it its is change changed the time to at no nah yes yeah starts start starting push pushed move moved bump " +
    "delay delayed shift back later earlier sooner up by min mins minute minutes hour hours hr hrs h from now not instead then ok okay " +
    "pls please lets let do can we i think maybe more like around about a an half for tomorrow today tonight midnight noon am pm " +
    "morning evening night afternoon oh wait sorry so and but sure one two three four five six couple few long of mon monday tue " +
    "tuesday wed wednesday thu thursday fri friday sat saturday sun sunday rn asap right instead lol haha its be will gonna going"
  ).split(" "),
);

/**
 * True when the reply is only a time or duration change ("no it's tomorrow at 7", "push it 30
 * min"). A longer message ("also picking up a bike tomorrow at 3 at Walmart") carries other
 * details, so the extractor must see it too.
 */
export function isPureEdit(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9:]+/)
    .filter((w) => w !== "" && !/\d/.test(w) && !EDIT_FILLER.has(w));
  return words.length <= 1;
}

/** Detect a time and/or duration edit in a reply. Deterministic; no model. */
export function detectPlanEdit(text: string, ctx: EditContext): DetectedEdit {
  const shift = detectShift(text, ctx.startAt);
  if (shift) return { time: { kind: "at", at: shift }, durationMin: null };
  const durationMin = detectDuration(text);
  const at = detectClock(text, ctx);
  if (!at) return { time: null, durationMin };
  if (ambiguous(text, at, ctx.tz)) return { time: { kind: "choice", options: [at, new Date(at.getTime() + 12 * 60 * MIN)] }, durationMin };
  return { time: { kind: "at", at }, durationMin };
}

/** Resolve the user's answer to "X or Y?" (am/pm, first/second, or a clock time). */
export function resolveTimeChoice(text: string, options: readonly Date[], ctx: EditContext): Date | null {
  const n = text.toLowerCase();
  const hourOf = (d: Date) => wallTime(d, ctx.tz).hour;
  const am = options.find((o) => hourOf(o) < 12) ?? null;
  const pm = options.find((o) => hourOf(o) >= 12) ?? null;
  if (/\b(am|a\.m|morning)\b|\d\s*(am|a\.m|a)\b/.test(n)) return am;
  if (/\b(pm|p\.m|afternoon|evening|night|tonight)\b|\d\s*(pm|p\.m|p)\b/.test(n)) return pm;
  if (/\b(first|1st|former)\b/.test(n)) return options[0] ?? null;
  if (/\b(second|2nd|latter|later one)\b/.test(n)) return options[1] ?? null;
  const at = detectClock(text, ctx);
  if (!at) return null;
  return options.find((o) => Math.abs(o.getTime() - at.getTime()) < MIN) ?? at;
}
