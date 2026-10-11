// Live bug (2026-10-10): the user's own display name ("Marky") was treated as the person they
// were meeting, and a time the user gave ("rn") still got "What time are you meeting?".
// Spec 4.4.2 counterpartName, 4.4.3 "never ask for something the user already said", 9.2, 9.4.
import { describe, expect, it } from "vitest";
import { extractPlan, fallbackExtract, parseTimeInTz, sanitizeCounterpart } from "../../../apps/server/src/nlu/extractPlan.js";
import { FakeLlmProvider } from "../../../apps/server/src/nlu/llm.js";
import { phraseQuestions, questionItem } from "../../../apps/server/src/notify/copy.js";
import { formatDayTime } from "../../../apps/server/src/geo/timezone.js";
import { USER, makeHarness, seedUser } from "./helpers.js";

const TZ = "America/Chicago";
const NOW = new Date("2026-10-17T20:00:00Z"); // Sat 3:00 PM CDT

const base = {
  type: null,
  startAtText: null,
  startAtISO: null,
  venueText: null,
  durationMin: null,
  counterpartName: null,
  counterpartSource: null,
  transport: null,
  firstTimeInPerson: null,
  buyOrSell: null,
  meetingAtPrivateAddress: null,
  userNervous: false,
  wantsToChange: [],
  confidence: 0.9,
};

describe("counterpart is never the user (4.4.2)", () => {
  it.each([
    ["Marky", "Marky", null],
    ["marky", "Marky", null],
    ["Marky", "Marky Smith", null],
    ["Marky Smith", "Marky", null],
    ["me", "Alex", null],
    ["I", "Alex", null],
    ["myself", "Alex", null],
    ["Jordan", "Marky", "Jordan"],
    ["Jordan", null, "Jordan"],
    ["Mark", "Marky", "Mark"],
  ])("sanitizeCounterpart(%s, user %s) -> %s", (name, user, expected) => {
    expect(sanitizeCounterpart(name, user)).toBe(expected);
  });

  it("drops a model counterpart equal to the user's own name, and tells the model who the user is", async () => {
    const llm = new FakeLlmProvider(() => ({ ...base, type: "other", counterpartName: "Marky", venueText: "Cookout" }));
    const r = await extractPlan({ messages: ["hey its marky, going to cookout"], now: NOW, tz: TZ, userName: "Marky" }, llm);
    expect(r.extraction.counterpartName).toBeNull();
    expect(r.extraction.venueText).toBe("Cookout");
    const sent = JSON.parse(llm.calls[0]!.user) as { userName?: string };
    expect(sent.userName).toBe("Marky");
  });

  it("the fallback extractor never returns the user's name either", () => {
    const e = fallbackExtract(["meeting Marky at Lula Cafe at 7"], NOW, TZ, { userName: "Marky" });
    expect(e.counterpartName).toBeNull();
  });

  it("intake never says the user is meeting themselves", async () => {
    const llm = new FakeLlmProvider((req) => {
      if (req.task === "extractPlan") return { ...base, type: "other", counterpartName: "Marky" };
      if (req.task === "phraseQuestions") return { text: "Nice, you're meeting Marky. What time are you meeting? Where are you meeting?" };
      throw new Error("unexpected");
    });
    const h = makeHarness({ llm });
    const { user } = await seedUser(h, { name: "Marky" });
    await h.text(USER, "meeting someone later");
    const plan = (await h.repo.getOpenPlanForUser(user.id))!;
    expect(plan.counterpartName).toBeNull();
    const q = h.sentTo(USER).at(-1)!;
    expect(q.text).not.toMatch(/marky/i);
    expect(q.text).toContain("What time are you meeting?");
  });
});

describe("LLM-phrased questions never address the user as the counterpart (9.4)", () => {
  it("rejects copy that names the user, with structured facts", async () => {
    const items = [questionItem("start_time"), questionItem("venue")];
    const llm = new FakeLlmProvider(() => ({ text: "Nice, you're meeting Marky. What time and where?" }));
    const r = await phraseQuestions(items, { userName: "Marky", counterpartName: null }, llm);
    expect(r.source).toBe("template");
    expect(r.rejected).toContain("names_user");
  });

  it("tells the model which name is the user and which is the counterpart", async () => {
    const items = [questionItem("start_time")];
    const llm = new FakeLlmProvider(() => ({ text: "What time are you meeting Jordan?" }));
    const r = await phraseQuestions(items, { userName: "Marky", counterpartName: "Jordan" }, llm);
    expect(r).toMatchObject({ source: "model", text: "What time are you meeting Jordan?" });
    const sent = JSON.parse(llm.calls[0]!.user) as { userName?: string; counterpartName?: string };
    expect(sent).toMatchObject({ userName: "Marky", counterpartName: "Jordan" });
  });
});

describe("a time the user gave is never asked again (4.4.3)", () => {
  it.each([["rn"], ["right now"], ["now"], ["asap"]])("'%s' resolves to now", (t) => {
    const d = parseTimeInTz(`heading to the cookout ${t}`, NOW, TZ);
    expect(d && formatDayTime(d, TZ)).toBe("Sat 3:00 PM");
  });

  it("a bare duration is not a start time", () => {
    expect(parseTimeInTz("actually make it 2 hours", NOW, TZ)).toBeNull();
    expect(parseTimeInTz("for 30 min", NOW, TZ)).toBeNull();
    expect(parseTimeInTz("in 30 min", NOW, TZ)?.toISOString()).toBe("2026-10-17T20:30:00.000Z");
  });

  it("'going to cookout with jordan rn' does not ask what time", async () => {
    const llm = new FakeLlmProvider((req) => {
      if (req.task === "extractPlan") return { ...base, type: "other", startAtText: "rn", startAtISO: null, venueText: "cookout", counterpartName: "Jordan" };
      throw new Error("no phrasing");
    });
    const h = makeHarness({ llm });
    const { user } = await seedUser(h, { name: "Marky" });
    await h.text(USER, "going to cookout with jordan rn");
    const plan = (await h.repo.getOpenPlanForUser(user.id))!;
    expect(plan.startAt?.toISOString()).toBe(NOW.toISOString());
    expect(h.sentTo(USER).some((s) => /what time/i.test(s.text))).toBe(false);
  });
});
