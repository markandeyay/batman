// M5 (spec 9.3, 4.6): the negation guard must not defeat commands aimed at someone else
// ("please dont hurt me"), and common physical-distress phrases count as explicit distress.
import { describe, expect, it } from "vitest";
import { classifyReply } from "../../../apps/server/src/nlu/classifyReply.js";
import { FakeLlmProvider } from "../../../apps/server/src/nlu/llm.js";
import { isExplicitDistress } from "../../../apps/server/src/nlu/rules.js";

describe("M5 explicit distress", () => {
  it.each([
    "please dont hurt me",
    "please don't hurt me",
    "don't touch me",
    "dont hit me",
    "do not touch me",
    "get off me",
    "GET OFF ME",
    "stop touching me",
    "let me go",
    "please let me go!",
    "leave me alone",
    "just leave me alone please",
    "i said dont touch me",
  ])("%s", (t) => {
    expect(isExplicitDistress(t)).toBe(true);
  });

  it.each([
    "i dont need help",
    "he didnt hurt me, all good",
    "not scared at all",
    "dont worry about me",
    "let me go grab a drink",
    "let me go check",
    "no need to come get me",
    "nobody is following me lol",
  ])("not distress: %s", (t) => {
    expect(isExplicitDistress(t)).toBe(false);
  });

  it("the rule pre-pass wins over a model that says OK", async () => {
    const llm = new FakeLlmProvider(() => ({ label: "OK", command: null, extendMin: null, confidence: 0.99 }));
    const r = await classifyReply({ text: "please don't touch me" }, llm);
    expect(r).toMatchObject({ label: "NOT_OK", distress: true, source: "rule" });
  });
});
