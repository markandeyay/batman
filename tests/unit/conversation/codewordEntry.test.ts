// Live bug (2026-10-10): code word entry needed three tries and repeated the format lecture.
// Spec 4.2: accept common forms; validation rules unchanged; ask one at a time when parsing fails.
// I8: code words never reach the model and are never logged.
import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../../../apps/server/src/nlu/llm.js";
import { parseCodeWordParts, parseCodeWordReply } from "../../../apps/server/src/pipeline/codewords.js";
import { GUARDIAN, USER, makeHarness, seedUser, type Harness } from "./helpers.js";

describe("parseCodeWordParts (4.2)", () => {
  it.each([
    ["exit pineapple alert blue moon", "pineapple", "blue moon", false],
    ["exit: pineapple, alert: blue moon", "pineapple", "blue moon", false],
    ['Exit: "pineapple"\nAlert: "blue moon"', "pineapple", "blue moon", false],
    ["pineapple\nblue moon", "pineapple", "blue moon", true],
    ["pineapple and blue moon", "pineapple", "blue moon", true],
    ["Pineapple & Blue Moon!", "pineapple", "blue moon", true],
    ["“pineapple”, “blue moon”", "pineapple", "blue moon", true],
    ["my exit word is pineapple and my alert word is blue moon", "pineapple", "blue moon", false],
    ["exit word is pineapple. alert word is blue moon.", "pineapple", "blue moon", false],
  ])("%s", (text, exit, alert, positional) => {
    expect(parseCodeWordParts(text)).toEqual({ exit, alert, positional });
    expect(parseCodeWordReply(text)).toEqual({ exit, alert });
  });

  it.each([
    ["exit word is pineapple", "pineapple", null],
    ["my exit word will be pineapple", "pineapple", null],
    ["pineapple is my exit word", "pineapple", null],
    ["alert: blue moon", null, "blue moon"],
  ])("partial: %s", (text, exit, alert) => {
    expect(parseCodeWordParts(text)).toEqual({ exit, alert, positional: false });
    expect(parseCodeWordReply(text)).toBeNull();
  });

  it("returns null when there is nothing to go on", () => {
    expect(parseCodeWordParts("idk what do you mean")).toBeNull();
    expect(parseCodeWordParts("pineapple")).toBeNull();
  });
});

/** New user at the code word step, with a model that must never be called. */
async function atCodewords(): Promise<{ h: Harness; llm: FakeLlmProvider; logs: string[] }> {
  const llm = new FakeLlmProvider(() => {
    throw new Error("the model must never see code word entry");
  });
  const h = makeHarness({ llm });
  const logs: string[] = [];
  h.ports.log = { info: (e, d) => logs.push(`${e} ${JSON.stringify(d ?? {})}`), warn: (e, d) => logs.push(`${e} ${JSON.stringify(d ?? {})}`) };
  await h.text(USER, "hi");
  await h.text(USER, "Marky");
  await h.inbound(USER, { kind: "contact", name: "Madhu", phones: [GUARDIAN] });
  h.clear();
  llm.calls.length = 0;
  return { h, llm, logs };
}

async function savedWords(h: Harness) {
  return h.repo.getCodeWords((await h.repo.getUserByAddress(USER))!.id);
}

describe("onboarding code word entry", () => {
  it("'pineapple and blue moon' is accepted first try and the reply says which is which", async () => {
    const { h, llm, logs } = await atCodewords();
    expect(await h.text(USER, "pineapple and blue moon")).toBe("onboarding_done");
    expect(await savedWords(h)).toEqual({ exit: "pineapple", alert: "blue moon" });
    const out = h.sentTo(USER);
    expect(out[0]!.template).toBe("onb_codewords_order");
    expect(out[0]!.text).toContain("pineapple");
    expect(out[0]!.text).toContain("blue moon");
    expect(out[0]!.text.indexOf("pineapple")).toBeLessThan(out[0]!.text.indexOf("blue moon"));
    expect(out.map((s) => s.template)).toEqual(["onb_codewords_order", "onb_save_contact", "onb_disclosure_done"]);
    expect(llm.calls).toEqual([]);
    expect(logs.join("\n")).not.toMatch(/pineapple|blue moon/i);
  });

  it("explicit labels need no order confirmation", async () => {
    const { h } = await atCodewords();
    expect(await h.text(USER, "exit: pineapple, alert: blue moon")).toBe("onboarding_done");
    expect(h.sentTo(USER).map((s) => s.template)).toEqual(["onb_save_contact", "onb_disclosure_done"]);
  });

  it("unparseable: asks one at a time instead of repeating the format", async () => {
    const { h, llm, logs } = await atCodewords();
    expect(await h.text(USER, "idk what should they be")).toBe("onboarding_codewords_invalid");
    expect(h.sentTo(USER).at(-1)!.template).toBe("onb_codeword_ask");
    expect(h.sentTo(USER).at(-1)!.text).toContain("What's your exit word?");
    expect(h.sentTo(USER).at(-1)!.text).not.toContain("exit pineapple, alert blue moon");
    expect(await h.text(USER, "pineapple")).toBe("onboarding_codewords_invalid");
    expect(h.sentTo(USER).at(-1)!.text).toContain("And your alert word?");
    expect(await h.text(USER, "it's blue moon")).toBe("onboarding_done");
    expect(await savedWords(h)).toEqual({ exit: "pineapple", alert: "blue moon" });
    expect(llm.calls).toEqual([]);
    expect(logs.join("\n")).not.toMatch(/pineapple|blue moon/i);
  });

  it("'exit word is pineapple' alone asks only for the alert word", async () => {
    const { h } = await atCodewords();
    await h.text(USER, "exit word is pineapple");
    expect(h.sentTo(USER).at(-1)!.text).toContain("And your alert word?");
    expect(await h.text(USER, "blue moon")).toBe("onboarding_done");
    expect(await savedWords(h)).toEqual({ exit: "pineapple", alert: "blue moon" });
  });

  it("one at a time keeps the 4.2 rules, with a short reason and the same question", async () => {
    const { h } = await atCodewords();
    await h.text(USER, "huh");
    await h.text(USER, "thanks"); // deny-listed
    expect(h.sentTo(USER).at(-1)!.text).toMatch(/too common.*What's your exit word\?/);
    await h.text(USER, "cat"); // too short
    expect(h.sentTo(USER).at(-1)!.text).toMatch(/at least 5 letters.*What's your exit word\?/);
    await h.text(USER, "zebra");
    await h.text(USER, "zebras"); // too similar to the exit word
    expect(h.sentTo(USER).at(-1)!.text).toMatch(/too close.*alert word\?/);
    expect(await h.text(USER, "purple rain")).toBe("onboarding_done");
    expect(await savedWords(h)).toEqual({ exit: "zebra", alert: "purple rain" });
  });

  it("a full pair still works in the middle of one-at-a-time", async () => {
    const { h } = await atCodewords();
    await h.text(USER, "huh");
    expect(await h.text(USER, "exit pineapple alert blue moon")).toBe("onboarding_done");
  });

  it("change code words uses the same parser and never reaches the model", async () => {
    const llm = new FakeLlmProvider(() => {
      throw new Error("never");
    });
    const h = makeHarness({ llm });
    const { user } = await seedUser(h);
    await h.text(USER, "change code words");
    expect(await h.text(USER, "marmalade and purple rain")).toBe("codewords_changed");
    expect(await h.repo.getCodeWords(user.id)).toEqual({ exit: "marmalade", alert: "purple rain" });
    expect(llm.calls).toEqual([]);
  });
});
