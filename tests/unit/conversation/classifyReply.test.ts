import { describe, expect, it } from "vitest";
import { classifyReply } from "../../../apps/server/src/nlu/classifyReply.js";
import { FakeLlmProvider } from "../../../apps/server/src/nlu/llm.js";

const model = (label: string, confidence = 0.95, extra: Record<string, unknown> = {}) =>
  new FakeLlmProvider(() => ({ label, command: null, extendMin: null, confidence, ...extra }));

describe("classifyReply (spec 9.3)", () => {
  it("rule pre-pass wins over the model and skips the call", async () => {
    const llm = model("OK");
    expect((await classifyReply({ text: "he won't let me leave" }, llm)).label).toBe("NOT_OK");
    expect((await classifyReply({ text: "+30" }, llm)).command).toBe("extend");
    expect((await classifyReply({ text: "home" }, llm)).command).toBe("home");
    expect(llm.calls.length).toBe(0);
  });

  it("explicit distress is flagged for L3 plus exit call", async () => {
    const r = await classifyReply({ text: "please come get me" }, model("OK"));
    expect(r).toMatchObject({ label: "NOT_OK", distress: true, source: "rule" });
  });

  it("uses the fast model for everything else", async () => {
    const r = await classifyReply({ text: "yeah lol" }, model("OK", 0.95));
    expect(r).toMatchObject({ label: "OK", source: "model" });
  });

  it("downgrades low-confidence OK to AMBIGUOUS", async () => {
    const r = await classifyReply({ text: "sure i guess" }, model("OK", 0.6));
    expect(r).toMatchObject({ label: "AMBIGUOUS", postCheck: "low_confidence" });
  });

  it("downgrades OK when a distress term appears", async () => {
    const r = await classifyReply({ text: "fine but he's kinda pushy" }, model("OK", 0.99));
    expect(r).toMatchObject({ label: "AMBIGUOUS", postCheck: "distress_lexicon" });
  });

  it("keeps NOT_OK from the model", async () => {
    expect((await classifyReply({ text: "eh not sure about this guy" }, model("NOT_OK", 0.9))).label).toBe("NOT_OK");
  });

  it("falls back to rules when the model fails (S-22)", async () => {
    const down = new FakeLlmProvider(() => {
      throw new Error("503");
    });
    expect((await classifyReply({ text: "im good" }, down)).label).toBe("OK");
    expect((await classifyReply({ text: "not really" }, down)).label).toBe("NOT_OK");
    expect((await classifyReply({ text: "what?" }, down))).toMatchObject({ label: "AMBIGUOUS", source: "fallback" });
  });

  it("falls back when the model exceeds the timeout", async () => {
    const slow = new FakeLlmProvider(() => ({ label: "NOT_OK", command: null, extendMin: null, confidence: 1 }), 200);
    const r = await classifyReply({ text: "im good" }, slow, { timeoutMs: 20 });
    expect(r).toMatchObject({ label: "OK", source: "fallback" });
  });

  it("no model configured uses rules", async () => {
    expect((await classifyReply({ text: "yep all good" }, null)).label).toBe("OK");
  });

  it("model COMMAND extend defaults to 30", async () => {
    const r = await classifyReply({ text: "staying out with them for dinner" }, model("COMMAND", 0.9, { command: "extend" }));
    expect(r).toMatchObject({ label: "COMMAND", command: "extend", extendMin: 30 });
  });
});
