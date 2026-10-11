// Replay of the first live iPhone session (2026-10-10, Fly.io) through the full stack: real
// dialogue, engine, runtime, scheduler, SQLite store, and templates; scripted LLM; fake clock.
// The human's verdict was "it ignores what I say and goes with premade prompts". Inbound bodies
// were not stored, so the texts below are plausible reconstructions; the time edits are the
// phrasings the human confirmed they tried at the plan confirmation.
// Asserts: the counterpart is never the user's name; no identical plan_confirm twice in a row;
// an edit re-confirms only the changed field; a question gets an answer plus the nudge; and a
// plan whose backup never said yes does not expire the instant it is armed (X4 revised).
import { afterEach, describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../../apps/server/src/nlu/llm.js";
import { EXTRACTION_BASE, FullStack, GUARDIAN } from "./fullstack.js";

/** Minutes from START (Sat 7:00 PM New York): the session ran at Sat 10:54 PM. */
const T = 234;

function liveLlm() {
  return new FakeLlmProvider((req) => {
    if (req.task === "extractPlan") {
      const msgs = (JSON.parse(req.user) as { messages: string[] }).messages;
      const last = msgs[msgs.length - 1]!.toLowerCase();
      if (last.includes("cookout")) {
        return { ...EXTRACTION_BASE, type: "other", startAtText: "now", startAtISO: null, venueText: "cookout", counterpartName: "Jordan" };
      }
      return EXTRACTION_BASE;
    }
    if (req.task === "smallTalk") {
      const u = JSON.parse(req.user) as { facts: { guardianName: string | null } };
      return { text: `Only ${u.facts.guardianName ?? "your backup"}, and only if something seems off and you don't answer me.` };
    }
    throw new Error(`no ${req.task} in this replay`); // phrasing falls back to the fixed bank
  });
}

let s: FullStack | null = null;
afterEach(() => {
  s?.close();
  s = null;
});

describe("live transcript replay (2026-10-10)", () => {
  it("listens to the user: name, code words, edits, a question, GO, and no instant expiry", async () => {
    s = new FullStack({ startMin: T, llm: liveLlm() });
    const userTexts = () => s!.sent.filter((m) => m.to === "user");
    const lastUser = () => userTexts().at(-1)!;
    const reply = async (text: string) => {
      const before = userTexts().length;
      await s!.text("user", text);
      return userTexts().slice(before);
    };

    // Onboarding: hi, name, contact card, a code word attempt that used to fail twice.
    await s.text("user", "hi");
    expect(s.sends(-Infinity, "user")).toEqual(["user:onb_hello", "user:onb_ask_name"]);
    await s.text("user", "Marky");
    expect(lastUser().template).toBe("onb_ask_guardian");
    await s.inbound("user", { kind: "contact", name: "Madhu", phones: [GUARDIAN] });
    expect(userTexts().slice(-2).map((m) => m.template)).toEqual(["onb_guardian_text_first", "onb_ask_codewords"]);
    const cw = await reply("pineapple and blue moon");
    expect(cw.map((m) => m.template)).toEqual(["onb_codewords_order", "onb_save_contact", "onb_disclosure_done"]);
    expect(cw[0]!.text).toMatch(/"pineapple" is your exit word and "blue moon" is your alert word/);

    // The plan, starting now: straight to one confirmation.
    const first = await reply("going to cookout with jordan now");
    expect(first.map((m) => m.template)).toEqual(["plan_confirm"]);
    expect(first[0]!.text).toContain("Meetup with Jordan, Sat 10:54 PM at cookout");
    expect(s.plan()!.counterpartName).toBe("Jordan");

    // An edit re-confirms only the changed field.
    expect((await reply("actually make it 2 hours")).map((m) => m.text)).toEqual([
      "Updated: about 2 hours, back by about 12:54 AM. Reply GO to lock it in.",
    ]);

    // A question gets a brief answer plus the one-line nudge, never the summary.
    expect((await reply("wait who's gonna get texted?")).map((m) => m.text)).toEqual([
      "Only Madhu, and only if something seems off and you don't answer me.",
      "Reply GO when you're ready, or tell me what to change.",
    ]);

    // Every time edit the human tried at the confirmation (coordinator list).
    const edits: [string, string][] = [
      ["actually 11:30", "Sat 11:30 PM"],
      ["change the time to 11", "Sat 11:00 PM"],
      ["it's at midnight", "Sun 12:00 AM"],
      ["make it 11:30pm", "Sat 11:30 PM"],
      ["push it 30 min", "Sun 12:00 AM"],
      ["an hour from now", "Sat 11:54 PM"],
      ["no it's tomorrow at 7", "Sun 7:00 PM"],
    ];
    for (const [text, when] of edits) {
      expect((await reply(text)).map((m) => m.text), text).toEqual([`Updated: ${when}. Reply GO to lock it in.`]);
    }
    // Ambiguous: one question, then the update.
    expect((await reply("change it to 2")).map((m) => m.text)).toEqual(["Just to be sure, Sun 2:00 AM or Sun 2:00 PM?"]);
    expect((await reply("pm")).map((m) => m.text)).toEqual(["Updated: Sun 2:00 PM. Reply GO to lock it in."]);
    expect((await reply("starts at 11 not now")).map((m) => m.text)).toEqual(["Updated: Sat 11:00 PM. Reply GO to lock it in."]);

    // GO: Madhu never texted Batman, so the plan waits for them and says so once, honestly.
    const go = await reply("go");
    expect(go.map((m) => m.template)).toEqual(["plan_awaiting_guardian"]);
    expect(go[0]!.text).toContain("Madhu hasn't said yes to being your backup yet, so I can't lock this in until they do. I'll lock it in the moment they reply.");
    expect(s.plan()!.state).toBe("AWAITING_GUARDIAN");

    // No instant expiry: past the 11:00 PM start it is still waiting.
    await s.runUntil(T + 20);
    expect(s.plan()!.state).toBe("AWAITING_GUARDIAN");
    expect(s.sent.some((m) => m.template === "plan_expired_unarmed")).toBe(false);
    // It expires at the planned end (1:00 AM, start 11:00 PM plus 2 hours) with the honest copy.
    await s.runUntil(T + 6 + 120 + 1);
    expect(s.plan()!.state).toBe("EXPIRED");
    const expired = s.sent.filter((m) => m.template === "plan_expired_unarmed");
    expect(expired).toHaveLength(1);
    expect(expired[0]!.t).toBe(360);

    // Global checks over the whole conversation.
    const confirms = userTexts().filter((m) => m.template === "plan_confirm");
    expect(confirms).toHaveLength(1);
    const texts = userTexts().map((m) => m.text);
    for (let i = 1; i < texts.length; i++) expect(texts[i], `repeat at ${i}`).not.toBe(texts[i - 1]);
    expect(texts.some((t) => /meeting marky/i.test(t))).toBe(false);
    expect(s.plan()!.counterpartName).not.toMatch(/marky/i);
    // I1: Madhu never texted Batman, so Batman never texted Madhu.
    expect(s.guardianSends()).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it("the guardian says yes after the start: straight to ACTIVE, no expiry", async () => {
    s = new FullStack({ startMin: T, llm: liveLlm() });
    await s.text("user", "hi");
    await s.text("user", "Marky");
    await s.inbound("user", { kind: "contact", name: "Madhu", phones: [GUARDIAN] });
    await s.text("user", "pineapple and blue moon");
    await s.text("user", "going to cookout with jordan now");
    await s.text("user", "go");
    expect(s.plan()!.state).toBe("AWAITING_GUARDIAN");
    s.at(T + 10, "guardian", "hi").at(T + 11, "guardian", "yes");
    await s.runUntil(T + 12);
    expect(s.plan()!.state).toBe("ACTIVE");
    expect(s.transitions()).toEqual(["DRAFT->AWAITING_GUARDIAN", "AWAITING_GUARDIAN->ACTIVE"]);
    expect(s.sent.some((m) => m.template === "plan_expired_unarmed")).toBe(false);
    expect(s.sends(T + 11, "user")).toEqual(expect.arrayContaining(["user:usr_guardian_in", "user:plan_armed_now", "user:loc_request_intro"]));
  });
});
