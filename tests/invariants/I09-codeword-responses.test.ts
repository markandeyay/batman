// I9. Code word responses never reveal anything: innocuous friend-like copy, no mention of safety,
// alerts, calls, or the guardian. The dialogue layer itself sends nothing after a code word; the
// engine sends the innocuous reply.
import { describe, expect, it } from "vitest";
import { findBannedWords } from "../../apps/server/src/notify/discretion.js";
import { renderAllVariants } from "../../apps/server/src/notify/templates.js";
import { USER, makeHarness, seedPlan, seedUser } from "../unit/conversation/helpers.js";

const REVEALING = /\b(call(ing)?|alert|guardian|backup|priya|safe|safety|help|location|emergency|911|code|word|batman)\b/i;

describe("I9 code word responses", () => {
  it.each(["cw_exit_reply", "cw_alert_reply", "cw_call_fallback_text"] as const)("%s variants are innocuous", (id) => {
    for (const t of renderAllVariants(id, { userName: "Alex", guardianName: "Priya" })) {
      expect(findBannedWords(t)).toEqual([]);
      if (id !== "cw_call_fallback_text") expect(t).not.toMatch(REVEALING);
      expect(t.length).toBeLessThanOrEqual(20);
    }
  });

  it("the fallback text reads like a friend asking for a call, nothing more", () => {
    expect(renderAllVariants("cw_call_fallback_text")).toEqual(["Call me asap"]);
  });

  it("after a code word the dialogue sends no message of its own", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ACTIVE");
    await h.text(USER, "pineapple");
    await h.text(USER, "blue moon");
    expect(h.sent).toEqual([]);
    expect(h.dispatched.map((d) => d.event.type)).toEqual(["exit_word", "alert_word"]);
  });
});
