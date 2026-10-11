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
    // "yeah lol" is now settled by the clear-reply rule; use text only the model can judge.
    const r = await classifyReply({ text: "honestly hes been really sweet" }, model("OK", 0.95));
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
    // "im good" is now settled by the clear-reply rule before any model call; use text that needs the model.
    const r = await classifyReply({ text: "this place is pretty nice" }, slow, { timeoutMs: 20 });
    expect(r).toMatchObject({ label: "AMBIGUOUS", source: "fallback" });
  });

  it("no model configured uses rules", async () => {
    expect((await classifyReply({ text: "yep all good" }, null)).label).toBe("OK");
  });

  it("model COMMAND extend defaults to 30", async () => {
    const r = await classifyReply({ text: "staying out with them for dinner" }, model("COMMAND", 0.9, { command: "extend" }));
    expect(r).toMatchObject({ label: "COMMAND", command: "extend", extendMin: 30 });
  });

  describe("clear-reply rules (deterministic, before the model)", () => {
    const never = new FakeLlmProvider(() => { throw new Error("model must not be called"); });
    it("whole-message clear positives are OK without the model", async () => {
      for (const t of ["perfect", "amazing", "yeah lol", "im good", "😊", "👍"]) {
        expect(await classifyReply({ text: t, state: "CHECKING", lastPrompt: "Hey, everything good?" }, never)).toMatchObject({ label: "OK", source: "rule" });
      }
    });
    it("bare negatives to a wellbeing check are NOT_OK", async () => {
      for (const t of ["no", "naw", "nope", "nah"]) {
        expect(await classifyReply({ text: t, state: "CHECKING", lastPrompt: "Hey, everything good?" }, never)).toMatchObject({ label: "NOT_OK", source: "rule" });
      }
    });
    it("a bare no to \"Still out?\" is not treated as distress", async () => {
      const r = await classifyReply({ text: "no", state: "OVERTIME", lastPrompt: "Still out? Reply +30 if you are staying" }, model("AMBIGUOUS", 0.7));
      expect(r.label).toBe("AMBIGUOUS");
    });
    it("a question back is never a clear positive", async () => {
      for (const q of ["ok?", "k?", "good?"]) {
        const r = await classifyReply({ text: q, state: "CHECKING" }, model("AMBIGUOUS", 0.7));
        expect(r.label).toBe("AMBIGUOUS");
      }
    });
    it("fear emoji alone is NOT_OK", async () => {
      expect(await classifyReply({ text: "😰", state: "CHECKING" }, never)).toMatchObject({ label: "NOT_OK", source: "rule" });
    });
    it("a positive word with a distress term still goes to the model path", async () => {
      const r = await classifyReply({ text: "fine but he is kinda pushy", state: "CHECKING" }, model("OK", 0.99));
      expect(r.label).not.toBe("OK");
    });
  });
});
