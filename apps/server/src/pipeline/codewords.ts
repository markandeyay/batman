// Code word detection (spec 9.1) and onboarding validation (spec 4.2).
// Pure, synchronous, deterministic. No LLM, no I/O (invariant I8). Never log code words.
import { doubleMetaphone } from "double-metaphone";

export type CodeWordKind = "exit" | "alert";
export type MatchMethod = "exact" | "fuzzy" | "joined" | "phonetic";

export interface CodeWords {
  exit: string;
  alert: string;
}

export interface CodeWordMatch {
  kind: CodeWordKind;
  method: MatchMethod;
}

/** Spec 4.2 deny list: common reply words that can never be (part of) a code word. */
export const CODEWORD_DENY_LIST: readonly string[] = [
  "ok", "okay", "yes", "no", "yeah", "yep", "nope", "good", "fine", "great", "done",
  "home", "help", "stop", "cancel", "here", "sure", "thanks", "lol", "haha",
];

/** Minimum letters in a single code token before fuzzy matching is allowed (spec 9.1). */
export const FUZZY_MIN_LETTERS = 5;

/**
 * Spec 9.1 normalization: Unicode NFKC, lowercase, strip punctuation and emoji, collapse
 * whitespace. Apostrophes are removed without a space so "don't" stays one token; every other
 * non letter, digit, or mark becomes a space.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['‘’ʼ`´]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  const n = normalizeText(text);
  return n === "" ? [] : n.split(" ");
}

export function letterCount(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

/**
 * Damerau-Levenshtein distance (optimal string alignment: insert, delete, substitute,
 * transpose adjacent). `max` lets callers stop early once the distance exceeds it.
 */
export function damerauLevenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  const A = Array.from(a);
  const B = Array.from(b);
  if (Math.abs(A.length - B.length) > max) return max + 1;
  if (A.length === 0) return B.length;
  if (B.length === 0) return A.length;
  const rows = A.length + 1;
  const cols = B.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i]![0] = i;
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j < cols; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return d[A.length]![B.length]!;
}

function tokenMatches(msgTok: string, codeTok: string): "exact" | "fuzzy" | null {
  if (msgTok === codeTok) return "exact";
  if (letterCount(codeTok) >= FUZZY_MIN_LETTERS && damerauLevenshtein(msgTok, codeTok, 1) <= 1) return "fuzzy";
  return null;
}

function phoneticCodes(token: string): string[] {
  const letters = token.replace(/[^\p{L}]/gu, "");
  if (letters === "") return [];
  const [p, s] = doubleMetaphone(letters);
  return [p, s].filter((c, i, arr) => c.length > 0 && arr.indexOf(c) === i);
}

function phoneticEqual(a: string, b: string, minCodeLen: number): boolean {
  const ca = phoneticCodes(a);
  const cb = phoneticCodes(b);
  return ca.some((x) => x.length >= minCodeLen && cb.includes(x));
}

/** Match one normalized code phrase against message tokens. Returns the best method or null. */
function matchPhrase(msg: string[], phrase: string[], fromVoice: boolean): MatchMethod | null {
  if (phrase.length === 0 || msg.length === 0) return null;
  let best: MatchMethod | null = null;
  const rank: Record<MatchMethod, number> = { exact: 0, fuzzy: 1, joined: 2, phonetic: 3 };
  const consider = (m: MatchMethod) => {
    if (best === null || rank[m] < rank[best]) best = m;
  };

  // 1. Contiguous token sequence, exact or per-token fuzzy (tokens of 5+ letters only).
  for (let i = 0; i + phrase.length <= msg.length; i++) {
    let fuzzy = false;
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      const r = tokenMatches(msg[i + j]!, phrase[j]!);
      if (r === null) {
        ok = false;
        break;
      }
      if (r === "fuzzy") fuzzy = true;
    }
    if (ok) {
      if (!fuzzy) return "exact";
      consider("fuzzy");
    }
  }

  // 2. Autocorrect-style splits and merges: "pine apple" for "pineapple", "bluemoon" for
  // "blue moon". Compare joined windows of message tokens with the joined phrase. Fuzzy is
  // only allowed for a single code token of 5+ letters, so short words are never fuzzed.
  const target = phrase.join("");
  const singleLong = phrase.length === 1 && letterCount(target) >= FUZZY_MIN_LETTERS;
  const minK = phrase.length === 1 ? 2 : 1;
  for (let i = 0; i < msg.length; i++) {
    let joined = "";
    for (let k = 1; k <= phrase.length + 2 && i + k <= msg.length; k++) {
      joined += msg[i + k - 1]!;
      if (joined.length > target.length + 1) break;
      if (k < minK) continue;
      if (k === phrase.length && phrase.length > 1) continue; // covered by step 1
      if (joined === target || (singleLong && damerauLevenshtein(joined, target, 1) <= 1)) consider("joined");
    }
  }

  // 3. Voice transcripts: phonetic match via Double Metaphone ("blew moon" for "blue moon").
  if (fromVoice && best === null) {
    for (let i = 0; i + phrase.length <= msg.length; i++) {
      let ok = true;
      for (let j = 0; j < phrase.length; j++) {
        const m = msg[i + j]!;
        const c = phrase[j]!;
        if (tokenMatches(m, c) === null && !phoneticEqual(m, c, 2)) {
          ok = false;
          break;
        }
      }
      if (ok) return "phonetic";
    }
    for (let i = 0; i < msg.length; i++) {
      let joined = "";
      for (let k = 1; k <= phrase.length + 2 && i + k <= msg.length; k++) {
        joined += msg[i + k - 1]!;
        if (joined.length > target.length + 3) break;
        if (phoneticEqual(joined, target, 3)) return "phonetic";
      }
    }
  }
  return best;
}

/**
 * Detect the user's code words in a message (spec 9.1). If both appear, the alert word wins.
 * `fromVoice` enables the Double Metaphone pass for voice-note transcripts.
 */
export function matchCodeWords(
  text: string,
  codeWords: CodeWords,
  opts: { fromVoice?: boolean } = {},
): CodeWordMatch | null {
  const msg = tokenize(text);
  if (msg.length === 0) return null;
  const fromVoice = opts.fromVoice === true;
  const alertTokens = tokenize(codeWords.alert);
  const exitTokens = tokenize(codeWords.exit);
  const alert = matchPhrase(msg, alertTokens, fromVoice);
  if (alert) return { kind: "alert", method: alert };
  const exit = matchPhrase(msg, exitTokens, fromVoice);
  if (exit) return { kind: "exit", method: exit };
  return null;
}

// ---------- Onboarding validation (spec 4.2) ----------

export type CodeWordInvalidReason =
  | "format" // could not tell which is the exit word and which is the alert word
  | "word_count" // each must be 1 to 3 words
  | "too_short" // at least 5 letters total
  | "common_word" // contains a deny-listed reply word
  | "same" // exit and alert are equal
  | "too_similar"; // within edit distance 2, or one contains the other

export type CodeWordValidation =
  | { ok: true; codeWords: CodeWords }
  | { ok: false; reason: CodeWordInvalidReason; which?: CodeWordKind };

export function validateCodePhrase(phrase: string): CodeWordInvalidReason | null {
  const toks = tokenize(phrase);
  if (toks.length === 0) return "format";
  if (toks.length > 3) return "word_count";
  if (letterCount(toks.join("")) < 5) return "too_short";
  if (toks.some((t) => CODEWORD_DENY_LIST.includes(t))) return "common_word";
  return null;
}

function containsSeq(hay: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

export function validateCodeWords(exit: string, alert: string): CodeWordValidation {
  const e = validateCodePhrase(exit);
  if (e) return { ok: false, reason: e, which: "exit" };
  const a = validateCodePhrase(alert);
  if (a) return { ok: false, reason: a, which: "alert" };
  const et = tokenize(exit);
  const at = tokenize(alert);
  const ej = et.join(" ");
  const aj = at.join(" ");
  if (ej === aj) return { ok: false, reason: "same" };
  if (damerauLevenshtein(et.join(""), at.join(""), 2) <= 2 || containsSeq(et, at) || containsSeq(at, et)) {
    return { ok: false, reason: "too_similar" };
  }
  return { ok: true, codeWords: { exit: ej, alert: aj } };
}

const LEAD_FILLER = new Set([
  "word", "words", "is", "will", "be", "should", "my", "the", "code", "phrase", "as", "to", "s", "its", "it", "id",
  "make", "use", "lets", "um", "uh", "hmm", "so", "and", "then", "maybe",
]);
const TRAIL_FILLER = new Set(["and", "then", "plus", "also", "my", "the", "is", "as", "word", "words", "please", "pls", "code", "be", "will", "would"]);

function trimFiller(tokens: string[]): string[] {
  let s = 0;
  let e = tokens.length;
  while (s < e && LEAD_FILLER.has(tokens[s]!)) s++;
  while (e > s && TRAIL_FILLER.has(tokens[e - 1]!)) e--;
  return tokens.slice(s, e);
}

/** What a code word reply contained. positional: no labels, so the order was assumed (exit, alert). */
export interface CodeWordParts {
  exit: string | null;
  alert: string | null;
  positional: boolean;
}

/** Phrase for a lone keyword: the words after it, or before it ("pineapple is my exit word"). */
function aroundKeyword(toks: string[], i: number): string[] {
  const after = trimFiller(toks.slice(i + 1));
  if (after.length > 0) return after;
  return trimFiller(toks.slice(0, i));
}

/**
 * Parse a code word reply (spec 4.2). Accepts "exit pineapple alert blue moon",
 * "exit: pineapple, alert: blue moon", two lines, "1) pineapple 2) blue moon",
 * "pineapple and blue moon" or "pineapple, blue moon" (exit first, positional), and a single
 * labeled word ("exit word is pineapple"). Punctuation and quotes are ignored. Returns null when
 * nothing usable was found. Deterministic; never logs or forwards the words (I8).
 */
export function parseCodeWordParts(text: string): CodeWordParts | null {
  const toks = tokenize(text);
  const ei = toks.indexOf("exit");
  const ai = toks.indexOf("alert");
  if (ei >= 0 && ai >= 0) {
    const exitToks = ei < ai ? toks.slice(ei + 1, ai) : toks.slice(ei + 1);
    const alertToks = ai < ei ? toks.slice(ai + 1, ei) : toks.slice(ai + 1);
    const ex = trimFiller(exitToks);
    const al = trimFiller(alertToks);
    if (ex.length === 0 && al.length === 0) return null;
    return { exit: ex.length > 0 ? ex.join(" ") : null, alert: al.length > 0 ? al.join(" ") : null, positional: false };
  }
  if (ei >= 0 || ai >= 0) {
    const words = aroundKeyword(toks, ei >= 0 ? ei : ai);
    if (words.length === 0) return null;
    return ei >= 0 ? { exit: words.join(" "), alert: null, positional: false } : { exit: null, alert: words.join(" "), positional: false };
  }
  const numbered = /1\s*[).:-]\s*([\s\S]+?)\s*2\s*[).:-]\s*([\s\S]+)/.exec(text);
  if (numbered) {
    const ex = tokenize(numbered[1]!);
    const al = tokenize(numbered[2]!);
    if (ex.length > 0 && al.length > 0) return { exit: ex.join(" "), alert: al.join(" "), positional: false };
  }
  for (const sep of [/[\n,;/]+/, /\s+(?:and|then|&|plus)\s+|\s*&\s*/i]) {
    const parts = text
      .split(sep)
      .map((p) => trimFiller(tokenize(p)))
      .filter((p) => p.length > 0);
    if (parts.length === 2) return { exit: parts[0]!.join(" "), alert: parts[1]!.join(" "), positional: true };
  }
  return null;
}

/**
 * Parse the user's code word reply into both words, or null when it cannot tell which is which
 * (see parseCodeWordParts for the accepted forms).
 */
export function parseCodeWordReply(text: string): CodeWords | null {
  const p = parseCodeWordParts(text);
  return p && p.exit && p.alert ? { exit: p.exit, alert: p.alert } : null;
}

/** One code word sent on its own ("it's blue moon", "exit: pineapple"). Null when empty. */
export function parseSingleCodePhrase(text: string): string | null {
  const toks = trimFiller(tokenize(text).filter((t) => t !== "exit" && t !== "alert"));
  return toks.length > 0 ? toks.join(" ") : null;
}

/** Replace code words in a message body with "[code]" for storage (spec 12). */
export function redactCodeWords(text: string, codeWords: CodeWords | null): string {
  if (!codeWords) return text;
  return matchCodeWords(text, codeWords, { fromVoice: true }) ? "[code]" : text;
}
