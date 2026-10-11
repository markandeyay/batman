// L1 (I4, I12): at info level and above, coordinates are dropped by key AND scrubbed out of
// strings (coordinate pairs and maps URLs). Debug keeps them for local troubleshooting.
import { describe, expect, it } from "vitest";
import { scrub } from "../../../apps/server/src/util/log.js";

describe("L1 log scrubbing", () => {
  const msg = "alert body: Last location 41.917234, -87.706712 https://maps.apple.com/?ll=41.9172,-87.7067&q=Alex and https://www.google.com/maps?q=41.91,-87.70";
  it("drops coordinate pairs and maps links inside strings at info", () => {
    const out = scrub({ text: msg, nested: { note: "at 41.9172,-87.7067" } }, true) as { text: string; nested: { note: string } };
    expect(out.text).not.toMatch(/41\.9|87\.70|maps\.apple|google\.com\/maps/);
    expect(out.text).toContain("[loc]");
    expect(out.nested.note).not.toMatch(/41\.9/);
  });
  it("keeps ordinary numbers and times", () => {
    expect(scrub("plan at 7:00 PM, 2 min ago, ±20 m, 3.5 hours", true)).toBe("plan at 7:00 PM, 2 min ago, ±20 m, 3.5 hours");
  });
  it("debug level keeps coordinates", () => {
    expect(scrub("at 41.9172,-87.7067", false)).toBe("at 41.9172,-87.7067");
  });
});
