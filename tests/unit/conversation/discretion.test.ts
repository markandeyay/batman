import { describe, expect, it } from "vitest";
import { countEmoji, findBannedWords, hasEmDash, hasMarkdown, isDiscreet, validateCopy } from "../../../apps/server/src/notify/discretion.js";

describe("discretion filter (I10)", () => {
  it.each(["Your safety matters", "ALERT sent", "this is an emergency", "you may be in danger", "Batman here", "quick check-in", "just a check in", "call 911", "I told your guardian"])(
    "flags %s",
    (t) => expect(isDiscreet(t)).toBe(false),
  );
  it.each(["Hey, everything good?", "Text me back when you can 🙂", "Still out?", "checking out the menu", "lol ok"])("allows %s", (t) => {
    expect(isDiscreet(t)).toBe(true);
  });
  it("lists the banned words found", () => {
    expect(findBannedWords("Safety alert from Batman")).toEqual(["safety", "alert", "batman"]);
  });
});

describe("format checks", () => {
  it("counts emoji graphemes", () => {
    expect(countEmoji("hi 🙂")).toBe(1);
    expect(countEmoji("⚠️ hi")).toBe(1);
    expect(countEmoji("👍🏽👍")).toBe(2);
    expect(countEmoji("no emoji +30")).toBe(0);
  });
  it("detects em dashes", () => {
    expect(hasEmDash("a \u2014 b")).toBe(true);
    expect(hasEmDash("a - b")).toBe(false);
  });
  it("detects markdown", () => {
    for (const t of ["**bold**", "# Title", "- item", "1. first", "[x](http://a)", "`code`", "> quote"]) expect(hasMarkdown(t)).toBe(true);
    for (const t of ["Got it. What time?", "1) an EXIT word", "+30 min"]) expect(hasMarkdown(t)).toBe(false);
  });
});

describe("validateCopy (spec 9.4)", () => {
  const facts = ["What time are you meeting?", "Where are you meeting?", "Jordan", "Lula Cafe"];
  it("accepts grounded short copy", () => {
    expect(validateCopy("Got it. What time are you meeting Jordan, and where?", facts)).toEqual({ ok: true, reasons: [] });
  });
  it.each([
    ["x".repeat(281), "too_long"],
    ["**What time?**", "markdown"],
    ["Nice \u2014 what time?", "em_dash"],
    ["What time? 🙂🙂", "too_many_emoji"],
    ["Stay safe! What time?", "banned:safe"],
    ["What time? I'll text you at 9", "ungrounded_number:9"],
    ["Is it with Morgan? What time?", "ungrounded_name:Morgan"],
    ["See https://evil.example", "ungrounded_url"],
  ])("rejects %s", (text, reason) => {
    const r = validateCopy(text, facts);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain(reason);
  });
});
