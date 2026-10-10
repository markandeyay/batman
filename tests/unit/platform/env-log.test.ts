import { describe, expect, it } from "vitest";
import { capabilities, loadEnv } from "../../../apps/server/src/config/env.ts";
import { redactPhones, scrub } from "../../../apps/server/src/util/log.ts";

const base = {
  SPECTRUM_PROJECT_ID: "proj",
  SPECTRUM_PROJECT_SECRET: "super-secret-value",
  BATMAN_LINE_E164: "+19195550100",
  ANTHROPIC_API_KEY: "sk-ant-test",
  LLM_MODEL_SMART: "claude-opus-5-5",
};

describe("loadEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = loadEnv({ source: { ...base }, root: "/repo" });
    expect(env.LLM_PROVIDER).toBe("anthropic");
    expect(env.TIME_SCALE).toBe(1);
    expect(env.LOCATION_SOURCE).toBe("findmy");
    expect(env.TEST_MODE).toBe(false);
    expect(env.ADMIN_NUMBERS).toEqual([]);
  });

  it("treats blank optional values as absent", () => {
    const env = loadEnv({ source: { ...base, OPENAI_API_KEY: "", HUMAN_IPHONE_E164: "" }, root: "/repo" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HUMAN_IPHONE_E164).toBeUndefined();
    expect(capabilities(env).speech).toBe(false);
  });

  it("reports variable names but never values on failure", () => {
    let message = "";
    try {
      loadEnv({ source: { ...base, BATMAN_LINE_E164: "919-555-0100", ANTHROPIC_API_KEY: "" }, root: "/repo" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("BATMAN_LINE_E164");
    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).not.toContain("super-secret-value");
    expect(message).not.toContain("919-555-0100");
  });

  it("validates admin numbers as E.164", () => {
    expect(() => loadEnv({ source: { ...base, ADMIN_NUMBERS: "+19195550100,12345" }, root: "/repo" })).toThrow(/ADMIN_NUMBERS/);
    const env = loadEnv({ source: { ...base, ADMIN_NUMBERS: "+19195550100, +19195550101" }, root: "/repo" });
    expect(env.ADMIN_NUMBERS).toEqual(["+19195550100", "+19195550101"]);
  });

  it("requires a geocoder key for paid geocoders", () => {
    expect(() => loadEnv({ source: { ...base, GEOCODER: "mapbox" }, root: "/repo" })).toThrow(/GEOCODER_API_KEY/);
  });
});

describe("log redaction (spec 8.1)", () => {
  it("redacts phone numbers to the last 4 digits", () => {
    expect(redactPhones("from +19195550142 to (919) 555-0100")).toBe("from ***0142 to ***0100");
  });

  it("drops coordinates at info level and keeps them at debug", () => {
    const fix = { lat: 41.9, lng: -87.6, accuracyM: 20 };
    expect(scrub(fix, true)).toEqual({ accuracyM: 20 });
    expect(scrub(fix, false)).toEqual(fix);
  });

  it("always replaces secret-looking keys", () => {
    expect(scrub({ token: "abc", projectSecret: "x", nested: { authorization: "Basic y" } }, false)).toEqual({
      token: "[redacted]",
      projectSecret: "[redacted]",
      nested: { authorization: "[redacted]" },
    });
  });
});
