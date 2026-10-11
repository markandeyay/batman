// Generated code word suite (spec 9.1, 7.5): each code word x {exact, uppercase, trailing
// punctuation, embedded in a sentence, one typo (every single-edit variant of each 5+ letter
// token), autocorrect-style split, merge} plus voice-transcript homophones and "both" cases.
import { letterCount, tokenize, validateCodeWords, type CodeWordKind, type CodeWords } from "../../apps/server/src/pipeline/codewords.js";

/** Code word pairs a user could pick (all pass onboarding validation, spec 4.2). */
export const EVAL_PAIRS: CodeWords[] = [
  { exit: "pineapple", alert: "blue moon" },
  { exit: "flamingo", alert: "purple rain" },
  { exit: "marmalade", alert: "thunderbolt" },
  { exit: "avocado toast", alert: "red balloon" },
  { exit: "tangerine dream", alert: "zeppelin" },
  { exit: "bumblebee", alert: "snow globe" },
  { exit: "kumquat", alert: "lighthouse keeper" },
  { exit: "waffle iron", alert: "starfish" },
  { exit: "banana bread", alert: "dragonfly" },
  { exit: "cactus", alert: "periwinkle" },
];

/** Voice transcript variants an STT model plausibly produces. */
const HOMOPHONES: Record<string, string[]> = {
  "blue moon": ["blew moon", "blue moon"],
  "purple rain": ["purple reign", "purple rein"],
  "red balloon": ["read balloon"],
  "snow globe": ["snow globe", "snowglobe"],
  pineapple: ["pine apple", "pineapple"],
  dragonfly: ["dragon fly"],
  starfish: ["star fish"],
  "lighthouse keeper": ["light house keeper"],
  "waffle iron": ["waffle iron"],
  kumquat: ["come quat", "kumquat"],
  zeppelin: ["zeppelin"],
};

export interface CodewordCase {
  pair: number;
  text: string;
  expected: CodeWordKind | null;
  variant: string;
  fromVoice: boolean;
}

const EMBED = ["omg {w} lol", "ok so {w} haha", "hey {w}", "{w} btw", "can you grab {w} on your way", "lol {w} right now"];

function typoVariants(token: string): string[] {
  const out = new Set<string>();
  const chars = Array.from(token);
  for (let i = 0; i < chars.length; i++) {
    out.add([...chars.slice(0, i), ...chars.slice(i + 1)].join("")); // deletion
    const sub = chars[i] === "x" ? "q" : "x";
    out.add([...chars.slice(0, i), sub, ...chars.slice(i + 1)].join("")); // substitution
    out.add([...chars.slice(0, i), "z", ...chars.slice(i)].join("")); // insertion
    if (i + 1 < chars.length && chars[i] !== chars[i + 1]) {
      const t = [...chars];
      [t[i], t[i + 1]] = [t[i + 1]!, t[i]!];
      out.add(t.join("")); // transposition
    }
  }
  out.add(token + "z");
  out.delete(token);
  return [...out];
}

export function generateCodewordCases(pairs: CodeWords[] = EVAL_PAIRS): CodewordCase[] {
  const cases: CodewordCase[] = [];
  pairs.forEach((pair, pi) => {
    const v = validateCodeWords(pair.exit, pair.alert);
    if (!v.ok) throw new Error(`eval pair ${pi} fails onboarding validation: ${v.reason}`);
    for (const kind of ["exit", "alert"] as const) {
      const phrase = pair[kind];
      const toks = tokenize(phrase);
      const add = (text: string, variant: string, fromVoice = false) => cases.push({ pair: pi, text, expected: kind, variant, fromVoice });
      add(phrase, "exact");
      add(phrase.toUpperCase(), "uppercase");
      add(phrase.charAt(0).toUpperCase() + phrase.slice(1), "capitalized");
      for (const p of ["!", ".", "?", "!!!", "...", " 🙂"]) add(phrase + p, "trailing_punctuation");
      for (const e of EMBED) add(e.replace("{w}", phrase), "embedded");
      toks.forEach((tok, ti) => {
        if (letterCount(tok) < 5) return;
        for (const typo of typoVariants(tok)) {
          const t = [...toks];
          t[ti] = typo;
          add(t.join(" "), "one_typo");
          add(`omg ${t.join(" ")}`, "one_typo_embedded");
        }
      });
      // Autocorrect-style split of the longest 5+ letter token, at every interior position.
      const longest = toks.reduce((a, b) => (b.length > a.length ? b : a), "");
      if (letterCount(longest) >= 5) {
        for (let cut = 2; cut <= longest.length - 2; cut++) {
          const t = toks.map((x) => (x === longest ? `${x.slice(0, cut)} ${x.slice(cut)}` : x));
          add(t.join(" "), "split");
        }
      }
      if (toks.length > 1) add(toks.join(""), "merged");
      for (const h of HOMOPHONES[phrase] ?? []) add(h, "voice_homophone", true);
      add(phrase, "voice_exact", true);
    }
    cases.push({ pair: pi, text: `${pair.exit} and ${pair.alert}`, expected: "alert", variant: "both_alert_wins", fromVoice: false });
    cases.push({ pair: pi, text: `${pair.alert}!! ${pair.exit}`, expected: "alert", variant: "both_alert_wins", fromVoice: false });
  });
  return cases;
}
