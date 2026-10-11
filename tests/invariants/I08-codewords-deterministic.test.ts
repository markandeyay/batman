// I8. Code words are detected deterministically, before any LLM call, on every inbound text and
// voice transcript. A code word is never missed because a model call failed or timed out.
import { describe, expect, it } from "vitest";
import { WINDOW_STATES } from "../../apps/server/src/contracts.js";
import { FakeLlmProvider } from "../../apps/server/src/nlu/llm.js";
import { matchCodeWords } from "../../apps/server/src/pipeline/codewords.js";
import { USER, makeHarness, seedPlan, seedUser } from "../unit/conversation/helpers.js";

const hanging = () => new FakeLlmProvider(() => new Promise(() => {}));
const failing = () =>
  new FakeLlmProvider(() => {
    throw new Error("model down");
  });

describe("I8 code words before any LLM", () => {
  it.each(WINDOW_STATES.map((s) => [s]))("in %s the code word wins with the LLM hanging or failing", async (state) => {
    for (const llm of [hanging(), failing()]) {
      const h = makeHarness({ llm });
      const { user, guardianId } = await seedUser(h);
      await seedPlan(h, user.id, guardianId, state);
      expect(await h.text(USER, "lol PINEAPPLE!!")).toBe("codeword_exit");
      expect(await h.text(USER, "blue moon", { fromVoice: true })).toBe("codeword_alert");
      expect(await h.text(USER, "pinapple")).toBe("codeword_exit"); // one typo
      expect(llm.calls).toEqual([]);
    }
  });

  it("the code word check runs before STOP, guardian routing, and keyword rules", async () => {
    const h = makeHarness({ llm: failing() });
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "CHECKING");
    expect(await h.text(USER, "help blue moon")).toBe("codeword_alert");
    expect(await h.text(USER, "pineapple done")).toBe("codeword_exit");
  });

  it("matching is pure and synchronous", () => {
    const cw = { exit: "pineapple", alert: "blue moon" };
    const r = matchCodeWords("PINEAPPLE", cw);
    expect(r).toEqual({ kind: "exit", method: "exact" });
    expect(matchCodeWords("PINEAPPLE", cw)).toEqual(r);
  });
});
