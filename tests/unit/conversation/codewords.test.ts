import { describe, expect, it } from "vitest";
import {
  damerauLevenshtein,
  matchCodeWords,
  normalizeText,
  parseCodeWordReply,
  redactCodeWords,
  validateCodeWords,
} from "../../../apps/server/src/pipeline/codewords.js";

const cw = { exit: "pineapple", alert: "blue moon" };

describe("normalizeText (spec 9.1)", () => {
  it("applies NFKC, lowercases, strips punctuation and emoji, collapses whitespace", () => {
    expect(normalizeText("  PINEAPPLE!!! 🍍  ")).toBe("pineapple");
    expect(normalizeText("Ｐｉｎｅａｐｐｌｅ")).toBe("pineapple");
    expect(normalizeText("don't\tstop…now")).toBe("dont stop now");
  });
});

describe("damerauLevenshtein", () => {
  it("counts transpositions as one edit", () => {
    expect(damerauLevenshtein("pineapple", "pinaepple")).toBe(1);
    expect(damerauLevenshtein("pineapple", "pinaple")).toBe(2);
    expect(damerauLevenshtein("abc", "abc")).toBe(0);
  });
});

describe("matchCodeWords (spec 9.1)", () => {
  it.each([
    ["pineapple", "exit"],
    ["PINEAPPLE", "exit"],
    ["pineapple!!", "exit"],
    ["omg pineapple lol", "exit"],
    ["pinaple", null],
    ["pinapple", "exit"],
    ["pine apple", "exit"],
    ["blue moon", "alert"],
    ["Blue Moon.", "alert"],
    ["bluemoon", "alert"],
    ["blue moom", null],
    ["i like apples", null],
    ["the moon is blue", null],
  ])("%s -> %s", (text, kind) => {
    expect(matchCodeWords(text, cw)?.kind ?? null).toBe(kind);
  });

  it("S-14: one typo in a 5+ letter word is detected", () => {
    expect(matchCodeWords("pinapple", cw)).toEqual({ kind: "exit", method: "fuzzy" });
  });

  it("S-15: 'pineapples are gross' matches (distance 1), documented behaviour", () => {
    expect(matchCodeWords("pineapples are gross", cw)?.kind).toBe("exit");
  });

  it("never fuzzy-matches words shorter than 5 letters", () => {
    expect(matchCodeWords("blue mood", cw)).toBeNull();
    expect(matchCodeWords("glue moon", cw)).toBeNull();
  });

  it("alert wins when both appear", () => {
    expect(matchCodeWords("pineapple blue moon", cw)?.kind).toBe("alert");
    expect(matchCodeWords("blue moon then pineapple", cw)?.kind).toBe("alert");
  });

  it("uses Double Metaphone only for voice transcripts", () => {
    expect(matchCodeWords("I want a blew moon", cw)).toBeNull();
    expect(matchCodeWords("I want a blew moon", cw, { fromVoice: true })).toEqual({ kind: "alert", method: "phonetic" });
  });

  it("is synchronous (no promise)", () => {
    const r = matchCodeWords("pineapple", cw) as unknown;
    expect(r instanceof Promise).toBe(false);
  });

  it("redacts code words for storage", () => {
    expect(redactCodeWords("ok pineapple", cw)).toBe("[code]");
    expect(redactCodeWords("see you soon", cw)).toBe("see you soon");
  });
});

describe("code word onboarding validation (spec 4.2)", () => {
  it("accepts the spec example", () => {
    expect(validateCodeWords("pineapple", "blue moon")).toEqual({ ok: true, codeWords: { exit: "pineapple", alert: "blue moon" } });
  });
  it.each([
    ["ok", "pineapple", "too_short"],
    ["yes please", "pineapple", "common_word"],
    ["one two three four", "pineapple", "word_count"],
    ["pineapple", "pineapple", "same"],
    ["zebra", "cobra", "too_similar"],
    ["blue moon", "blue moon rising", "too_similar"],
    ["pineapple", "home run", "common_word"],
    ["cat", "pineapple", "too_short"],
  ])("%s / %s -> %s", (exit, alert, reason) => {
    const r = validateCodeWords(exit, alert);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
});

describe("parseCodeWordReply", () => {
  it.each([
    ["exit pineapple alert blue moon", "pineapple", "blue moon"],
    ["exit pineapple, alert blue moon", "pineapple", "blue moon"],
    ["Exit: pineapple / Alert: blue moon", "pineapple", "blue moon"],
    ["alert word is blue moon and exit word is pineapple", "pineapple", "blue moon"],
    ["1) pineapple 2) blue moon", "pineapple", "blue moon"],
    ["pineapple, blue moon", "pineapple", "blue moon"],
  ])("%s", (text, exit, alert) => {
    expect(parseCodeWordReply(text)).toEqual({ exit, alert });
  });
  it("returns null when it cannot tell which is which", () => {
    expect(parseCodeWordReply("pineapple")).toBeNull();
    expect(parseCodeWordReply("exit pineapple")).toBeNull();
  });
});
