import { describe, expect, it } from "vitest";
import { findPhonesInText, isSameNumber, normalizePhone, parsePhone, redactPhone } from "../../../apps/server/src/util/phone.js";

describe("util/phone", () => {
  it.each(["+1 919 555 0142", "(919) 555-0142", "919.555.0142", "19195550142", "919 555 0142"])("normalizes %s", (s) => {
    expect(normalizePhone(s)).toBe("+19195550142");
  });
  it("normalizes a real valid US number", () => {
    expect(normalizePhone("(212) 736-5000")).toBe("+12127365000");
  });
  it("keeps international numbers with a country code", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });
  it("rejects junk", () => {
    expect(parsePhone("12").ok).toBe(false);
    expect(parsePhone("call me").ok).toBe(false);
  });
  it("finds numbers in text", () => {
    const f = findPhonesInText("Priya 919 555 0142 thanks");
    expect(f[0]?.e164).toBe("+19195550142");
    expect("Priya 919 555 0142 thanks".slice(0, f[0]!.start).trim()).toBe("Priya");
  });
  it("compares numbers in any format", () => {
    expect(isSameNumber("+19195550142", "(919) 555-0142")).toBe(true);
  });
  it("redacts to the last 4 digits", () => {
    expect(redactPhone("+19195550142")).toBe("***0142");
    expect(redactPhone(null)).toBe("***");
  });
});
