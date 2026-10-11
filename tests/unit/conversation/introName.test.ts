import { describe, expect, it } from "vitest";
import { parseIntroducedName } from "../../../apps/server/src/dialogue/onboarding.ts";
import { renderTemplate } from "../../../apps/server/src/notify/templates.ts";

describe("first-message self-introduction (spec 4.2, never ask what the user already said)", () => {
  it("picks up the name from an explicit introduction", () => {
    for (const [text, name] of [
      ["Hi, I'm Robin", "Robin"],
      ["hi im robin", "Robin"],
      ["Hey! My name is Robin Lee", "Robin Lee"],
      ["this is Robin", "Robin"],
      ["hello, call me Robin.", "Robin"],
      ["I am Alex", "Alex"],
    ] as const) {
      expect(parseIntroducedName(text), text).toBe(name);
    }
  });

  it("does not treat a bare greeting or a plan as a name", () => {
    for (const text of ["hi", "hey there", "hello!", "yo", "I'm on a date at 7", "im going out tonight", "I'm fine", "i'm meeting someone", "what is this"]) {
      expect(parseIntroducedName(text), text).toBeNull();
    }
  });

  it("greets by name and opens the backup question with the quick-setup line", () => {
    expect(renderTemplate("onb_hello", { userName: "Robin" }, { variant: 0 })).toMatch(/^Hey Robin, I'm Batman\./);
    expect(renderTemplate("onb_hello", {}, { variant: 0 })).toMatch(/^Hey, I'm Batman\./);
    expect(renderTemplate("onb_ask_guardian", { quickSetup: true }, { variant: 0 })).toMatch(/^Quick setup, takes a minute\. Who should I contact/);
    expect(renderTemplate("onb_ask_guardian", { userName: "Robin" }, { variant: 0 })).toMatch(/^Nice to meet you, Robin\./);
  });
});
