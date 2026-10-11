import { describe, expect, it } from "vitest";
import { phraseQuestions, questionItem } from "../../../apps/server/src/notify/copy.js";
import { FakeLlmProvider, OpenAIProviderStub, createLlmProvider } from "../../../apps/server/src/nlu/llm.js";
import { NominatimGeocoder, createGeocoder, shortAddress, type FetchLike } from "../../../apps/server/src/geo/geocode.js";
import { formatClockRange, formatDayTime, isNight, resolveTz, tzForCoords, zonedWallTimeToUtc } from "../../../apps/server/src/geo/timezone.js";

describe("LLM-phrased intake questions (9.4)", () => {
  const items = [questionItem("start_time"), questionItem("venue")];
  it("uses validated model copy", async () => {
    const llm = new FakeLlmProvider(() => ({ text: "Nice! What time are you meeting, and where are you meeting?" }));
    const r = await phraseQuestions(items, ["Jordan"], llm);
    expect(r).toEqual({ text: "Nice! What time are you meeting, and where are you meeting?", source: "model" });
  });
  it("falls back to the bank when the model adds facts or banned words", async () => {
    for (const bad of ["Stay safe! What time?", "What time? I'll ping Morgan.", "**What time?**"]) {
      const r = await phraseQuestions(items, [], new FakeLlmProvider(() => ({ text: bad })));
      expect(r.source).toBe("template");
      expect(r.text).toBe("What time are you meeting? Where are you meeting?");
    }
  });
  it("falls back without a model or on error", async () => {
    expect((await phraseQuestions(items, [], null)).source).toBe("template");
    const r = await phraseQuestions(items, [], new FakeLlmProvider(() => Promise.reject(new Error("x"))));
    expect(r.rejected).toEqual(["llm_error"]);
  });
});

describe("LlmProvider selection", () => {
  it("anthropic without a key is null; openai is a stub that throws", async () => {
    expect(createLlmProvider({ LLM_PROVIDER: "anthropic" })).toBeNull();
    expect(createLlmProvider({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" })?.name).toBe("anthropic");
    const o = createLlmProvider({ LLM_PROVIDER: "openai" });
    expect(o).toBeInstanceOf(OpenAIProviderStub);
    await expect(o!.parse({} as never)).rejects.toThrow(/not configured/);
    expect(() => createLlmProvider({ LLM_PROVIDER: "foo" })).toThrow();
  });
});

describe("Nominatim geocoder", () => {
  it("sends a contact User-Agent and keeps requests at least 1 s apart", async () => {
    let now = 0;
    const calls: Array<{ url: string; ua: string | undefined; at: number }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, ua: init?.headers?.["User-Agent"], at: now });
      return { ok: true, status: 200, json: async () => [{ lat: "41.9", lon: "-87.7", display_name: "Lula Cafe, Chicago", type: "cafe", category: "amenity" }] };
    };
    const g = new NominatimGeocoder({ userAgent: "BatmanSafetyAgent/0.1 (ops@example.com)", fetch, nowMs: () => now, sleep: async (ms) => void (now += ms) });
    const [a, b] = await Promise.all([g.geocode("Lula Cafe"), g.geocode("Lula Cafe")]);
    expect(a[0]).toMatchObject({ lat: 41.9, lng: -87.7, residential: false });
    expect(b.length).toBe(1);
    expect(calls[0]!.ua).toContain("ops@example.com");
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(calls[0]!.url).toContain("nominatim.openstreetmap.org/search");
  });
  it("marks houses residential and survives errors", async () => {
    const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => [{ lat: "1", lon: "2", display_name: "x", type: "house", addresstype: "building" }] });
    const g = new NominatimGeocoder({ userAgent: "t", fetch, sleep: async () => {} });
    expect((await g.geocode("12 Elm St"))[0]?.residential).toBe(true);
    const broken = new NominatimGeocoder({ userAgent: "t", fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), sleep: async () => {} });
    expect(await broken.geocode("x")).toEqual([]);
  });
  it("createGeocoder picks providers", () => {
    expect(createGeocoder({}).name).toBe("nominatim");
    expect(createGeocoder({ GEOCODER: "mapbox", GEOCODER_API_KEY: "k" }).name).toBe("mapbox");
    expect(createGeocoder({ GEOCODER: "google", GEOCODER_API_KEY: "k" }).name).toBe("google");
    expect(() => createGeocoder({ GEOCODER: "mapbox" })).toThrow();
  });
  it("shortens addresses", () => {
    expect(shortAddress("1820, North Milwaukee Avenue, Bucktown, Chicago, Cook County, Illinois")).toBe("1820 North Milwaukee Avenue, Bucktown, Chicago");
  });
});

describe("timezone helpers", () => {
  it("looks up a timezone from coordinates (geo-tz)", () => {
    expect(tzForCoords(41.88, -87.63)).toBe("America/Chicago");
    expect(resolveTz({ explicit: null, fix: { lat: 40.71, lng: -74.0 }, defaultTz: "America/Denver" })).toBe("America/New_York");
    expect(resolveTz({ explicit: "Europe/London", defaultTz: "America/Denver" })).toBe("Europe/London");
    expect(resolveTz({ defaultTz: "nope" })).toBe("America/New_York");
  });
  it("converts wall time across DST", () => {
    expect(zonedWallTimeToUtc({ year: 2026, month: 7, day: 1, hour: 19, minute: 0 }, "America/New_York").toISOString()).toBe("2026-07-01T23:00:00.000Z");
    expect(zonedWallTimeToUtc({ year: 2026, month: 12, day: 1, hour: 19, minute: 0 }, "America/New_York").toISOString()).toBe("2026-12-02T00:00:00.000Z");
  });
  it("formats", () => {
    const s = new Date("2026-10-18T00:00:00Z");
    const e = new Date("2026-10-18T02:00:00Z");
    expect(formatDayTime(s, "America/Chicago")).toBe("Sat 7:00 PM");
    expect(formatClockRange(s, e, "America/Chicago")).toBe("7:00 to 9:00 PM");
    expect(isNight(new Date("2026-10-18T04:00:00Z"), "America/Chicago")).toBe(true);
  });
});
