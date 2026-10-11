// I4. Minimal disclosure: the guardian sees location only during an escalation, and only the
// user's location. Coordinates are never sent to anyone else.
import { afterEach, describe, expect, it } from "vitest";
import { DATE_EXTRACTION, FullStack, GUARDIAN } from "../sim/fullstack.js";

const sims: FullStack[] = [];
afterEach(() => sims.splice(0).forEach((s) => s.close()));

const LOCATION_RE = /maps\.(apple|google)\.com|[-+]?\d{1,3}\.\d{3,}\s*,\s*[-+]?\d{1,3}\.\d{3,}|Last location|location at/i;
const LOCATION_TEMPLATES = ["gdn_alert", "gdn_alert_repeat", "gdn_location_update"];

async function sim(track: string, script: [number, "user" | "guardian", string][], until: number): Promise<FullStack> {
  const s = new FullStack({ track, trackMessages: false, llm: { extract: [{ match: "jordan", out: DATE_EXTRACTION }] } });
  sims.push(s);
  await s.onboard();
  await s.planDate();
  for (const [t, who, text] of script) s.at(t, who, text);
  await s.runUntil(until);
  return s;
}

describe("I4 minimal disclosure", () => {
  it.each([
    ["no reply escalation, GOT IT, where is she", "date-overtime", [[160, "guardian", "got it"], [166, "guardian", "where is she"]], 200],
    ["alert word then home", "date-normal", [[60, "user", "blue moon"], [64, "guardian", "where is she"], [90, "user", "home"]], 120],
    ["normal date", "date-normal", [[130, "user", "home"]], 200],
  ] as const)("%s: location goes only to the guardian, only in ESCALATED", async (_n, track, script, until) => {
    const s = await sim(track, script as unknown as [number, "user" | "guardian", string][], until);
    const withLocation = s.sent.filter((m) => LOCATION_RE.test(m.text));
    for (const m of withLocation) {
      expect(m.address, m.text).toBe(GUARDIAN);
      expect(LOCATION_TEMPLATES).toContain(m.template);
      expect(m.state).toBe("ESCALATED");
    }
    // Nothing the user receives ever carries coordinates or a map link.
    expect(s.sent.filter((m) => m.to === "user" && LOCATION_RE.test(m.text))).toEqual([]);
  });

  it("where is she outside an escalation is refused", async () => {
    const s = await sim("date-normal", [[60, "guardian", "where is she"]], 61);
    expect(s.sends(59, "guardian")).toEqual(["guardian:gdn_location_denied"]);
    expect(s.sent.at(-1)!.text).toBe("I only share location during an alert.");
  });
});
