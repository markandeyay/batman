// Deterministic keyword rules (spec 8.4 step 8, 9.3 rule pre-pass, 4.6 command table, 4.9).
// Pure and synchronous. Run after code words and before any LLM call.
import { normalizeText } from "../pipeline/codewords.js";

export type KeywordRule =
  | { kind: "stop" }
  | { kind: "help" }
  | { kind: "distress" }
  | { kind: "extend"; minutes: number }
  | { kind: "home" }
  | { kind: "done" }
  | { kind: "cancel" }
  | { kind: "status" }
  | { kind: "change_backup" }
  | { kind: "change_codewords" }
  | { kind: "change_caller" }
  | { kind: "delete_data" }
  | { kind: "moving"; venueText: string };

/** Tokens that negate a following distress phrase ("not scared", "dont need help"). "no" is left
 * out on purpose: "no come get me" answers a check-in and is distress. */
const NEGATORS = new Set(["not", "dont", "never", "without", "isnt", "wasnt", "arent", "didnt", "doesnt", "aint", "nobody", "wouldnt", "shouldnt"]);
const NEGATIVE_TOKENS = new Set([...NEGATORS, "cant", "wont", "cannot", "no"]);

/** Explicit distress (spec 4.6): "help", "I don't feel safe", "come get me", "he won't let me leave". */
const EXPLICIT_DISTRESS: readonly string[] = [
  "dont feel safe", "do not feel safe", "dont feel very safe", "feel unsafe", "feeling unsafe", "im not safe", "i am not safe",
  "not safe here", "unsafe",
  "come get me", "please come get me", "come pick me up now", "pick me up asap", "come find me",
  "wont let me leave", "will not let me leave", "not letting me leave", "wont let me go", "not letting me go",
  "cant leave", "can not leave", "cannot leave", "cant get out", "cant get away",
  "help me", "please help", "i need help", "need help", "send help", "help please", "somebody help", "someone help", "pls help", "plz help",
  "call 911", "call the police", "call the cops", "call police", "call cops",
  "im scared", "i am scared", "so scared", "really scared", "im terrified", "terrified", "im afraid", "i am afraid", "scared for my life",
  "he hit me", "she hit me", "they hit me", "hit me", "hurt me", "hurting me", "attacked me", "assaulted", "grabbed me", "choked me",
  "drugged", "roofied", "spiked my drink", "something in my drink", "put something in my drink",
  "following me", "followed me", "being followed", "is following", "stalking me",
  "trapped", "locked me in", "locked in", "kidnapped", "took my phone", "took my keys", "took my wallet",
  "get me out", "get me out of here", "sos", "in danger", "threatening me", "threatened me", "has a gun", "has a knife", "pulled a knife", "pulled a gun",
  "forcing me", "forced me", "wont take no", "made me get in",
];

/** Broader lexicon: anything that hints the user is not okay (9.3 post-check, fallback NOT_OK). */
const DISTRESS_LEXICON: readonly string[] = [
  ...EXPLICIT_DISTRESS,
  "not ok", "not okay", "not good", "not great", "not really", "not so good", "not fine", "not doing well",
  "uncomfortable", "getting weird", "feels weird", "acting weird", "being weird", "kinda weird", "sketchy", "creepy", "creep",
  "scary", "scared", "afraid", "nervous", "worried", "freaked", "freaking out",
  "bad vibe", "bad vibes", "red flag", "want to leave", "wanna leave", "need to leave", "need to go", "get out",
  "aggressive", "pushy", "too drunk", "really drunk", "so drunk", "wasted", "dizzy", "wont stop", "touching me", "touched me", "yelling",
  "mad at me", "stranded", "no ride", "help", "call me", "pls call", "please call", "not safe", "unsafe",
  "danger", "dangerous", "hate this", "get away", "leave now", "go badly", "going badly", "went badly",
];

function stripApostrophes(s: string): string {
  return s.replace(/['‘’ʼ`]/g, "");
}

function norm(text: string): string {
  return normalizeText(stripApostrophes(text));
}

function containsPhrase(normText: string, phrase: string, opts: { negationGuard: boolean }): boolean {
  const toks = normText.split(" ");
  const p = phrase.split(" ");
  for (let i = 0; i + p.length <= toks.length; i++) {
    if (!p.every((t, j) => toks[i + j] === t)) continue;
    // Negation guard: "im not scared", "dont need help", "no need to come get me". Phrases that
    // are themselves negative ("dont feel safe", "wont let me leave") are never guarded.
    if (opts.negationGuard && !p.some((t) => NEGATIVE_TOKENS.has(t))) {
      const before = toks.slice(Math.max(0, i - 3), i);
      const joined = before.join(" ");
      if (before.some((t) => NEGATORS.has(t)) || /\bno need( to)?$/.test(joined)) continue;
    }
    return true;
  }
  return false;
}

export function isExplicitDistress(text: string): boolean {
  const n = norm(text);
  if (n === "") return false;
  if (n === "help" || n === "help help" || n === "sos") return true;
  return EXPLICIT_DISTRESS.some((p) => containsPhrase(n, p, { negationGuard: true }));
}

export function hasDistressLexicon(text: string): boolean {
  const n = norm(text);
  if (n === "") return false;
  if (/^(no|nope|nah|naw|nop|negative)( \w+)?$/.test(n) && !/^no (worries|problem|problems|prob|probs|biggie|issue|issues|stress|doubt|complaints)$/.test(n)) return true;
  return DISTRESS_LEXICON.some((p) => containsPhrase(n, p, { negationGuard: true }));
}

const FILLER_TRAIL = new Set(["lol", "lmao", "haha", "hahaha", "now", "thanks", "thx", "ty", "ok", "okay", "k", "btw", "rn", "xx", "x"]);

function stripTrailingFiller(n: string): string {
  const toks = n.split(" ");
  while (toks.length > 1 && FILLER_TRAIL.has(toks[toks.length - 1]!)) toks.pop();
  return toks.join(" ");
}

function unitMinutes(num: number, unit: string | undefined): number {
  if (unit && /^h/.test(unit)) return num * 60;
  return num;
}

function clampExtend(m: number): number {
  return Math.max(5, Math.min(240, Math.round(m)));
}

/** "+30", "add 30 min", "30 more minutes", "another hour", "going to be longer" (default +30). */
export function parseExtend(text: string): number | null {
  const raw = text.trim();
  const plus = /^\+\s*(\d{1,3})\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)?\b/i.exec(raw);
  if (plus) return clampExtend(unitMinutes(Number(plus[1]), plus[2]?.toLowerCase()));
  const n = norm(text);
  let m = /\b(?:add|another|extra|plus)\s+(\d{1,3})\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)?\b/.exec(n);
  if (m) return clampExtend(unitMinutes(Number(m[1]), m[2]));
  m = /\b(\d{1,3})\s*(?:more|extra)\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)\b/.exec(n);
  if (m) return clampExtend(unitMinutes(Number(m[1]), m[2]));
  m = /\b(\d{1,3})\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)\s+(?:more|longer|extra)\b/.exec(n);
  if (m) return clampExtend(unitMinutes(Number(m[1]), m[2]));
  if (/\b(another|one more|an extra|1 more) (hour|hr)\b|\ban hour (more|longer)\b/.test(n)) return 60;
  if (/\b(another|one more|an extra) (couple|few) (of )?hours\b|\bcouple more hours\b/.test(n)) return 120;
  if (/\b(another|an extra) half (an )?hour\b|\bhalf (an )?hour (more|longer)\b/.test(n)) return 30;
  if (
    /\b(going to|gonna|will|gon na|might) be (a (bit|little|lot) )?longer\b/.test(n) ||
    /\b(staying|stay) (a (bit|little) )?longer\b/.test(n) ||
    /\b(running|going) (a (bit|little) )?(long|over)\b/.test(n) ||
    /\b(getting|grabbing|going for|getting some) (dinner|drinks|food|dessert|a drink|another drink|coffee|ice cream) after\b/.test(n) ||
    /\b(few|couple) more (minutes|mins)\b/.test(n) ||
    /\bstill here\b.*\b(longer|more)\b/.test(n)
  ) {
    return 30;
  }
  return null;
}

const DONE_EXACT = new Set([
  "done", "im done", "were done", "we are done", "all done", "leaving", "im leaving", "we are leaving", "were leaving", "im out",
  "all good im out", "all good leaving", "left", "just left", "we left", "i left", "heading out", "headed out", "im heading out",
  "wrapping up", "wrapped up", "its over", "date is over", "date over", "all finished", "finished", "done here", "im done here",
  "out", "outta here", "im outta here", "good night", "goodnight", "on my way back", "omw back",
]);

/** "home", "made it home", "im home". Excludes "heading home" (that is done). */
export function isHome(text: string): boolean {
  const n = stripTrailingFiller(norm(text));
  if (/\b(heading|going|walking|driving|on my way|omw|headed|leaving for|getting|get) home\b/.test(n)) return false;
  if (/\b(not|never|didnt|havent|not yet) (home|made it)\b/.test(n)) return false;
  return (
    /^(im |i am |just |finally |got |made it |back |safe )*home( now| safe| safely| already)?$/.test(n) ||
    /\b(made it home|im home|i am home|got home|back home|home safe|safe at home|home now|im back home|arrived home)\b/.test(n)
  );
}

/**
 * "I'm okay now" (6.7 step 4): the only reply, besides home, done, and cancel, that ends an
 * alert-word or distress escalation (C2). Deterministic, whole message, no negation.
 */
export function isOkNow(text: string): boolean {
  let n = norm(text);
  for (let i = 0; i < 3; i++) n = n.replace(/ (lol|haha|thanks|thank you|thx|ty|really|promise|i promise|x|xx)$/, "");
  return /^(im|i am|i m) (ok|okay|alright|all right|fine|good) now$/.test(n);
}

export function isDone(text: string): boolean {
  const n = stripTrailingFiller(norm(text));
  if (DONE_EXACT.has(n)) return true;
  return /\b(heading|going|walking|driving|on my way|omw|headed) home\b/.test(n) && n.split(" ").length <= 8;
}

const CANCEL_EXACT = new Set([
  "cancel", "cancel it", "cancel plan", "cancel the plan", "cancel my plan", "cancelled", "canceled", "not going", "im not going",
  "not going anymore", "he cancelled", "she cancelled", "they cancelled", "he canceled", "she canceled", "they canceled",
  "its off", "plans off", "plan is off", "called it off", "we called it off", "never mind", "nevermind", "nvm", "not happening",
]);

export function isCancel(text: string): boolean {
  const n = stripTrailingFiller(norm(text));
  if (CANCEL_EXACT.has(n)) return true;
  return /\b(cancelled on me|canceled on me|bailed on me|stood me up|flaked)\b/.test(n);
}

const MOVING_RE =
  /\b(?:we(?:'|’)?re|were|we are|i(?:'|’)?m|im|i am)?\s*(?:moving|moved|heading over|going over|walking over|switching|switched|relocating|changing spots|changed spots)\s+(?:over\s+)?to\s+(.{2,80}?)[\s.!]*$/i;

/** "we're moving to the bar next door" -> "the bar next door". */
export function parseMoving(text: string): string | null {
  const m = MOVING_RE.exec(text.trim());
  if (!m) return null;
  const place = m[1]!.trim();
  if (/^(be|get|go home|stay|leave|head home|my place|bed)\b/i.test(place)) return null;
  return place;
}

/** Ordered deterministic rules. First match wins. */
export function matchKeywordRule(text: string): KeywordRule | null {
  const n = norm(text);
  if (n === "" && !/\+\s*\d/.test(text)) return null;
  const s = stripTrailingFiller(n);
  if (/^(stop|stop all|stopall|unsubscribe|stop texting me|stop messaging me|opt out|optout)$/.test(n)) return { kind: "stop" };
  // Bare "help" is the help command outside a window; the manager treats it as distress inside one.
  if (/^(help|info|commands|menu)$/.test(s)) return { kind: "help" };
  if (isExplicitDistress(text)) return { kind: "distress" };
  if (/\bdelete (all )?(of )?(my )?(data|account|everything|info|information)\b/.test(n)) return { kind: "delete_data" };
  if (/\b(change|new|switch|update|replace) (my )?(backup|guardian|emergency contact|contact person)\b/.test(n)) return { kind: "change_backup" };
  if (/\b(change|new|switch|update|reset) (my )?(code ?words?|secret words?|exit word|alert word)\b/.test(n)) return { kind: "change_codewords" };
  if (/\b(change|switch|update) (my |the )?(fake )?(caller|call voice|decoy)\b/.test(n)) return { kind: "change_caller" };
  if (/^(status|whats the plan|what is the plan|whats my plan|my plan|plan status|plan)$/.test(s)) return { kind: "status" };
  if (isCancel(text)) return { kind: "cancel" };
  const ext = parseExtend(text);
  if (ext !== null) return { kind: "extend", minutes: ext };
  if (isHome(text)) return { kind: "home" };
  if (isDone(text)) return { kind: "done" };
  const moving = parseMoving(text);
  if (moving) return { kind: "moving", venueText: moving };
  return null;
}

// ---------- Small-word helpers for dialogue context (yes/no, go) ----------

const AFFIRM = new Set([
  "yes", "y", "yeah", "yea", "ya", "yep", "yup", "sure", "ok", "okay", "k", "kk", "correct", "right", "thats right", "yes please",
  "yes thats right", "yess", "yesss", "absolutely", "definitely", "of course", "sounds good", "do it", "please", "si", "affirmative",
  "i accept", "accept", "accepted", "yes i accept", "happy to", "of course yes", "yes of course", "yes sure", "sure thing",
]);
const NEGATE = new Set(["no", "n", "nope", "nah", "naw", "no thanks", "no thank you", "wrong", "keep it", "keep", "dont", "negative", "decline", "i decline", "not now"]);

function hasThumbsUp(text: string): boolean {
  return /\u{1F44D}/u.test(text);
}

export function isAffirmative(text: string): boolean {
  const n = stripTrailingFiller(norm(text));
  return AFFIRM.has(n) || (n === "" && hasThumbsUp(text));
}

export function isNegative(text: string): boolean {
  const n = stripTrailingFiller(norm(text));
  return NEGATE.has(n) || (n === "" && /\u{1F44E}/u.test(text));
}

const GO = new Set([
  "go", "go go", "lets go", "lock it in", "lock it", "lock in", "locked", "yes", "yep", "yeah", "yup", "y", "confirm", "confirmed",
  "sounds good", "looks good", "perfect", "ok go", "go ahead", "do it", "ok", "okay", "k", "all good", "correct", "thats right", "yes go",
  "go for it", "send it", "arm it", "good", "great",
]);

/** "go" (or equivalent) after a plan confirmation (I1). */
export function isGo(text: string): boolean {
  const n = stripTrailingFiller(norm(text));
  return GO.has(n) || (n === "" && hasThumbsUp(text));
}

const OK_REPLY =
  /^(yes|yeah|yea|ya|yep|yup|yess+|ok|okay|k|kk|okk|good|im good|i am good|all good|were good|we are good|its good|its fine|fine|im fine|great|im great|doing good|doing great|doing well|all set|no worries|having fun|having a great time|having a good time|good so far|so far so good|its going well|going well|going great|pretty good|really good|totally fine|im okay|i am okay|im ok|all ok|everything is fine|everythings fine|everything good|everythings good|yes im good|yeah im good|yep all good|lol yes|lol yeah|yeah lol|haha yes|haha yeah|yes lol|lol im good|im alive|alive|still alive|still here|here|im here|sorry yes|sorry im good|sorry all good|all good here|good thanks|fine thanks|great thanks|perfect|amazing|awesome|10 10|chillin|chilling|vibing|we chillin|good good|yep yep|ya ya|all gucci|gucci|solid|cool|we good|we gucci|im chillin|thumbs up|on it)$/;

/**
 * Weak reply rule used only when the model fails (spec 9.3): NOT_OK on the distress lexicon,
 * OK on clear positive replies, otherwise null (caller treats as AMBIGUOUS).
 */
export function weakReplyLabel(text: string): "OK" | "NOT_OK" | null {
  if (hasDistressLexicon(text)) return "NOT_OK";
  const n = stripTrailingFiller(norm(text));
  if (n === "") {
    if (/[\u{1F44D}\u{2764}\u{1F602}\u{1F60A}\u{1F642}\u{1F44C}\u{1F60E}\u{1F970}\u{1F60D}\u{1F923}]/u.test(text)) return "OK";
    return null;
  }
  if (OK_REPLY.test(n)) return "OK";
  return null;
}
