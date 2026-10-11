import { describe, expect, it } from "vitest";
import { extractPlan, fallbackExtract, parseTimeInTz, resolveStartTime } from "../../../apps/server/src/nlu/extractPlan.js";
import { FakeLlmProvider } from "../../../apps/server/src/nlu/llm.js";
import { formatDayTime } from "../../../apps/server/src/geo/timezone.js";

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

describe("chrono re-check in the user's timezone", () => {
  it.each([
    ["at 7", "Sat 7:00 PM"],
    ["tonight 8:30", "Sat 8:30 PM"],
    ["7pm", "Sat 7:00 PM"],
    ["tomorrow at noon", "Sun 12:00 PM"],
    ["Sunday at 2", "Sun 2:00 PM"],
    ["at 10am tomorrow", "Sun 10:00 AM"],
    ["at 1", "Sun 1:00 AM"],
  ])("%s -> %s", (text, expected) => {
    const d = parseTimeInTz(text, NOW, TZ, "date");
    expect(d && formatDayTime(d, TZ)).toBe(expected);
  });

  it("relative times", () => {
    const d = parseTimeInTz("in an hour", NOW, TZ);
    expect(d?.toISOString()).toBe("2026-10-17T21:00:00.000Z");
  });

  it("no certain time means null", () => {
    expect(parseTimeInTz("tonight", NOW, TZ)).toBeNull();
    expect(parseTimeInTz("", NOW, TZ)).toBeNull();
  });

  it("flags > 15 min disagreement for confirmation (9.2)", () => {
    const r = resolveStartTime({ ...base, startAtText: "at 7", startAtISO: "2026-10-17T19:30:00-05:00" }, NOW, TZ);
    expect(r.needsConfirmation).toBe(true);
    expect(formatDayTime(r.startAt!, TZ)).toBe("Sat 7:00 PM");
  });

  it("accepts agreement within 15 min", () => {
    const r = resolveStartTime({ ...base, startAtText: "at 7", startAtISO: "2026-10-17T19:10:00-05:00" }, NOW, TZ);
    expect(r.needsConfirmation).toBe(false);
  });

  it("model-only time needs confirmation", () => {
    const r = resolveStartTime({ ...base, startAtText: "after work", startAtISO: "2026-10-17T18:00:00-05:00" }, NOW, TZ);
    expect(r).toMatchObject({ needsConfirmation: true, chronoAt: null });
  });

  it("past times propose the next day (4.4.5)", () => {
    const r = resolveStartTime({ ...base, startAtText: "today at 9am" }, NOW, TZ);
    expect(r.inPast).toBe(true);
    expect(formatDayTime(r.suggestedStart!, TZ)).toBe("Sun 9:00 AM");
  });
});

describe("extractPlan", () => {
  it("uses the model output with the 9.2 schema", async () => {
    const llm = new FakeLlmProvider(() => ({
      ...base,
      type: "date",
      startAtText: "at 7",
      startAtISO: "2026-10-17T19:00:00-05:00",
      venueText: "Lula Cafe",
      counterpartName: "Jordan",
      counterpartSource: "Hinge",
    }));
    const r = await extractPlan({ messages: ["date with Jordan from hinge at 7 at Lula Cafe"], now: NOW, tz: TZ }, llm);
    expect(r.source).toBe("model");
    expect(r.extraction.venueText).toBe("Lula Cafe");
    expect(r.time.needsConfirmation).toBe(false);
    expect(llm.calls[0]?.task).toBe("extractPlan");
  });

  it("rejects model output that breaks the schema and falls back", async () => {
    const llm = new FakeLlmProvider(() => ({ ...base, durationMin: 2 }));
    const r = await extractPlan({ messages: ["Selling my couch on Marketplace at 5pm"], now: NOW, tz: TZ }, llm);
    expect(r.source).toBe("fallback");
    expect(r.extraction.type).toBe("marketplace");
  });

  it("fallback extractor finds the obvious fields", () => {
    const e = fallbackExtract(["First date with Jordan from Hinge tonight at 7 at Lula Cafe, I'll drive"], NOW, TZ);
    expect(e).toMatchObject({ type: "date", counterpartName: "Jordan", counterpartSource: "Hinge", transport: "self_drive", firstTimeInPerson: true });
    expect(e.venueText).toBe("Lula Cafe");
    expect(e.startAtText).toContain("7");
  });

  it("fallback detects viewing, duration, and private address", () => {
    const e = fallbackExtract(["apartment viewing at his place at 2pm, should take about 30 min, kinda nervous"], NOW, TZ);
    expect(e).toMatchObject({ type: "viewing", durationMin: 30, meetingAtPrivateAddress: true, userNervous: true });
  });
});
