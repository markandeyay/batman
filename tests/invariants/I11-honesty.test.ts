// I11. Honesty with the guardian: alerts state what Batman knows and doesn't know ("hasn't
// replied for 6 min", "location last updated 4 min ago") and never claim certainty of danger.
import { afterEach, describe, expect, it } from "vitest";
import { DATE_EXTRACTION, FullStack } from "../sim/fullstack.js";

const sims: FullStack[] = [];
afterEach(() => sims.splice(0).forEach((s) => s.close()));

const CERTAINTY = /\b(is|are) in danger\b|\bdefinitely\b|\bfor sure\b|\bkidnapped\b|\bhas been (hurt|attacked|taken)\b|\bemergency\b/i;

async function escalate(track: string, opts: { trackMessages?: boolean } = {}): Promise<FullStack> {
  const s = new FullStack({ track, trackMessages: opts.trackMessages ?? false, llm: { extract: [{ match: "jordan", out: DATE_EXTRACTION }] } });
  sims.push(s);
  await s.onboard();
  await s.planDate();
  await s.runUntil(175);
  return s;
}

describe("I11 honesty with the guardian", () => {
  it("the alert hedges (might need help), says how long they've been silent, and how old the location is", async () => {
    const s = await escalate("date-overtime");
    const alert = s.sent.find((m) => m.template === "gdn_alert")!.text;
    expect(alert).toMatch(/^⚠️ Alex might need help\./);
    expect(alert).toContain("hasn't answered my messages (18 min)");
    expect(alert).toMatch(/Last location at \d{1,2}:\d{2} [AP]M \((just now|\d+ min ago), ±\d+ m\)/);
    expect(alert).toContain("If you think they're in danger, call 911.");
    for (const m of s.guardianSends()) expect(m.text, m.text).not.toMatch(CERTAINTY);
  });

  it("repeat alerts state the silence as of now, not as of the first alert", async () => {
    const s = await escalate("date-overtime");
    const minutes = s.sent.filter((m) => m.template === "gdn_alert" || m.template === "gdn_alert_repeat").map((m) => Number(/\((\d+) min\)/.exec(m.text)?.[1]));
    // Alert at 153 after 18 min of silence (since 135), then every 3 min.
    expect(minutes).toEqual([18, 21, 24, 27, 30, 33]);
  });

  it("an old location is reported with its age; no location is reported as unknown", async () => {
    const dark = await escalate("date-normal"); // drives home at 118, no 'home' text, location then goes stale
    const alert = dark.sent.find((m) => m.template === "gdn_alert")!.text;
    expect(alert).toMatch(/\(\d+ min ago, ±\d+ m\)/);
    expect(alert).toContain("location stopped updating");

    const none = await escalate("no-share");
    const t = none.sent.find((m) => m.template === "gdn_alert")!.text;
    expect(t).toContain("I don't have Alex's location for this meetup.");
    expect(t).not.toMatch(/maps\.apple\.com/);
  });

  it("the alert never claims a call that did not connect (calls fail on the shared pool)", async () => {
    const s = new FullStack({ track: "date-overtime", trackMessages: false, callsWork: false, llm: { extract: [{ match: "jordan", out: DATE_EXTRACTION }] } });
    sims.push(s);
    await s.onboard();
    await s.planDate();
    await s.runUntil(154);
    const alert = s.sent.find((m) => m.template === "gdn_alert")!.text;
    expect(alert).not.toMatch(/or a call|didn't pick up|missed (my )?call/);
  });
});
