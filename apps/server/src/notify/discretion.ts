// Discretion filter (I10) and the copy validator for LLM-phrased text (spec 9.4).
// Rules: at most 280 chars, no markdown, no em dashes, at most one emoji, no banned words, and
// nothing that is not grounded in the input facts. On rejection callers fall back to templates.

/**
 * Words that must never appear in user-facing copy during DISCREET_STATES (I10), and never in
 * LLM-phrased copy at all. Matched case-insensitively on word boundaries. Broader than the spec
 * list on purpose ("check in" without the hyphen, "911", "police", "guardian").
 */
export const BANNED_PATTERNS: ReadonlyArray<{ word: string; re: RegExp }> = [
  { word: "safety", re: /\bsafety\b/i },
  { word: "safe", re: /\b(un)?safe(ly|r|st)?\b/i },
  { word: "alert", re: /\balert(s|ed|ing)?\b/i },
  { word: "emergency", re: /\bemergenc(y|ies)\b/i },
  { word: "danger", re: /\bdanger(s|ous)?\b/i },
  { word: "batman", re: /\bbatman\b/i },
  { word: "check-in", re: /\bcheck[\s-]?ins?\b/i },
  { word: "911", re: /\b911\b/ },
  { word: "police", re: /\bpolice\b/i },
  { word: "guardian", re: /\bguardians?\b/i },
];

export function findBannedWords(text: string): string[] {
  const n = text.normalize("NFKC");
  return BANNED_PATTERNS.filter((b) => b.re.test(n)).map((b) => b.word);
}

/** True when the text would read like a text from a friend on a lock screen (I10). */
export function isDiscreet(text: string): boolean {
  return findBannedWords(text).length === 0;
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Number of emoji graphemes ("⚠️" and "👍🏽" count as one each). */
export function countEmoji(text: string): number {
  let n = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)) n++;
  }
  return n;
}

export function hasEmDash(text: string): boolean {
  return /[—―⸺⸻]/.test(text);
}

/** Markdown or list formatting that would render as literal symbols in iMessage. */
export function hasMarkdown(text: string): boolean {
  return (
    /(\*\*|__|`|~~)/.test(text) ||
    /^\s{0,3}#{1,6}\s/m.test(text) ||
    /^\s*[-*+•]\s+/m.test(text) ||
    /^\s*\d+\.\s+/m.test(text) || // "1." lists render as markdown; "1)" stays plain text (spec 4.2 copy)
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /^\s*>/m.test(text) ||
    /\|.*\|/.test(text) ||
    /(^|\s)\*[^*\s][^*]*\*(\s|$)/.test(text) ||
    /(^|\s)_[^_\s][^_]*_(\s|$)/.test(text)
  );
}

const ALWAYS_OK_CAPS = new Set([
  "i", "im", "ill", "id", "ive", "ok", "okay", "go", "am", "pm", "gps",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "tonight", "tomorrow", "marketplace", "find", "my", "share", "until", "end", "of", "day",
]);

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Validate LLM-phrased copy (spec 9.4). `facts` are the strings the model was given (names,
 * places, times, question texts); every number, URL, and mid-sentence capitalized word in the
 * output must be grounded in them.
 */
export function validateCopy(text: string, facts: readonly string[], opts: { maxChars?: number } = {}): ValidationResult {
  const reasons: string[] = [];
  const maxChars = opts.maxChars ?? 280;
  const t = text.trim();
  if (t.length === 0) reasons.push("empty");
  if (t.length > maxChars) reasons.push("too_long");
  if (hasMarkdown(t)) reasons.push("markdown");
  if (hasEmDash(t)) reasons.push("em_dash");
  if (countEmoji(t) > 1) reasons.push("too_many_emoji");
  const banned = findBannedWords(t);
  if (banned.length > 0) reasons.push("banned:" + banned.join(","));
  const factText = facts.join(" \n ").toLowerCase();
  if (/https?:\/\/|www\./i.test(t) && !/https?:\/\/|www\./i.test(factText)) reasons.push("ungrounded_url");
  for (const num of t.match(/\d+/g) ?? []) {
    if (!new RegExp(`(^|\\D)${num}(\\D|$)`).test(factText)) {
      reasons.push("ungrounded_number:" + num);
      break;
    }
  }
  // Capitalized words that do not start a sentence must come from the facts (names, places).
  const words = t.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!;
    const w = words[i]!.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (!/^\p{Lu}/u.test(w)) continue;
    if (/[.!?:]["')]*$/.test(prev)) continue;
    const key = w.toLowerCase().replace(/[^a-z]/g, "");
    if (ALWAYS_OK_CAPS.has(key)) continue;
    if (!factText.includes(w.toLowerCase())) {
      reasons.push("ungrounded_name:" + w);
      break;
    }
  }
  return { ok: reasons.length === 0, reasons };
}
