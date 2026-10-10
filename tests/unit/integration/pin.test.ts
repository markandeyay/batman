import { describe, expect, it } from "vitest";
import {
  isLocationVCardName,
  isValidLatLng,
  parseGeoUri,
  parseMapsUrl,
  parsePin,
  parsePinFromText,
  parseVCardPin,
  unescapeVCardValue,
} from "../../../apps/server/src/location/pin.js";

// Fixture shaped like the Apple "Send My Current Location" card (vCard 3.0, escaped comma).
// Spike S4 replaces or confirms this with the real captured card.
const APPLE_LOC_VCF = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//iPhone OS 18.0//EN",
  "N:;Current Location;;;",
  "FN:Current Location",
  "item1.URL;type=pref:http://maps.apple.com/?ll=37.331686\\,-122.030656&q=37.331686\\,-122.030656",
  "item1.X-ABLabel:map url",
  "END:VCARD",
].join("\r\n");

describe("parseMapsUrl", () => {
  it("reads ll= from an Apple Maps URL", () => {
    expect(parseMapsUrl("https://maps.apple.com/?ll=40.7484,-73.9857&q=Empire")).toEqual({
      lat: 40.7484,
      lng: -73.9857,
      source: "maps_url",
      field: "ll",
    });
  });

  it("reads q=lat,lng when ll is absent", () => {
    expect(parseMapsUrl("http://maps.apple.com/?q=51.5007,-0.1246")).toMatchObject({ lat: 51.5007, lng: -0.1246, field: "q" });
  });

  it("decodes a percent-encoded comma", () => {
    expect(parseMapsUrl("https://maps.apple.com/?ll=48.8584%2C2.2945")).toMatchObject({ lat: 48.8584, lng: 2.2945 });
  });

  it("handles a vCard-escaped comma inside the URL", () => {
    expect(parseMapsUrl("http://maps.apple.com/?ll=37.331686\\,-122.030656")).toMatchObject({ lat: 37.331686, lng: -122.030656 });
  });

  it("reads the newer /place?coordinate= form", () => {
    expect(parseMapsUrl("https://maps.apple.com/place?coordinate=35.6586,139.7454&name=Tower")).toMatchObject({
      lat: 35.6586,
      lng: 139.7454,
      field: "coordinate",
    });
  });

  it("prefers ll over a text q label", () => {
    expect(parseMapsUrl("https://maps.apple.com/?q=Dropped%20Pin&ll=-33.8568,151.2153")).toMatchObject({
      lat: -33.8568,
      lng: 151.2153,
      field: "ll",
    });
  });

  it("reads Google Maps q= and @lat,lng forms", () => {
    expect(parseMapsUrl("https://www.google.com/maps?q=12.9716,77.5946")).toMatchObject({ lat: 12.9716, lng: 77.5946 });
    expect(parseMapsUrl("https://www.google.com/maps/place/X/@41.8902,12.4922,17z")).toMatchObject({
      lat: 41.8902,
      lng: 12.4922,
      field: "@",
    });
  });

  it("rejects non-maps hosts, short links, out-of-range, and 0,0", () => {
    expect(parseMapsUrl("https://evil.example/?ll=40.7,-73.9")).toBeUndefined();
    expect(parseMapsUrl("https://maps.apple/p/AbCdEf")).toBeUndefined();
    expect(parseMapsUrl("https://maps.apple.com/?ll=95.0,10.0")).toBeUndefined();
    expect(parseMapsUrl("https://maps.apple.com/?ll=0,0")).toBeUndefined();
    expect(parseMapsUrl("https://maps.apple.com/?q=Coffee")).toBeUndefined();
    expect(parseMapsUrl("not a url")).toBeUndefined();
  });
});

describe("parseVCardPin", () => {
  it("parses the Apple Current Location card", () => {
    const v = parseVCardPin(APPLE_LOC_VCF);
    expect(v.isLocationCard).toBe(true);
    expect(v.name).toBe("Current Location");
    expect(v.urls).toEqual(["http://maps.apple.com/?ll=37.331686,-122.030656&q=37.331686,-122.030656"]);
    expect(v.coords).toEqual({ lat: 37.331686, lng: -122.030656, source: "maps_url", field: "ll" });
  });

  it("unfolds folded lines", () => {
    const folded = APPLE_LOC_VCF.replace("?ll=37.331686", "?ll=37.33\r\n 1686");
    expect(parseVCardPin(folded).coords).toMatchObject({ lat: 37.331686, lng: -122.030656 });
  });

  it("falls back to GEO in 3.0 and 4.0 forms", () => {
    expect(parseVCardPin("BEGIN:VCARD\nVERSION:3.0\nFN:Spot\nGEO:37.386013;-122.082932\nEND:VCARD").coords).toEqual({
      lat: 37.386013,
      lng: -122.082932,
      source: "vcard_geo",
      field: "GEO",
    });
    expect(parseVCardPin("BEGIN:VCARD\nVERSION:4.0\nGEO:geo:37.386013,-122.082932\nEND:VCARD").coords).toMatchObject({
      lat: 37.386013,
      source: "vcard_geo",
    });
  });

  it("does not treat a normal contact card as a location", () => {
    const v = parseVCardPin("BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nTEL;type=CELL:+15550001234\nURL:https://example.com\nEND:VCARD");
    expect(v.isLocationCard).toBe(false);
    expect(v.coords).toBeUndefined();
    expect(v.urls).toEqual(["https://example.com"]);
  });
});

describe("parsePin and helpers", () => {
  it("tries urls, then vcf, then text", () => {
    expect(parsePin({ urls: ["https://example.com", "http://maps.apple.com/?ll=1.5,2.5"] })).toMatchObject({ lat: 1.5, lng: 2.5 });
    expect(parsePin({ urls: [], vcf: APPLE_LOC_VCF })).toMatchObject({ lat: 37.331686 });
    expect(parsePin({ text: "I'm here https://maps.apple.com/?ll=10.1,20.2." })).toMatchObject({ lat: 10.1, lng: 20.2 });
    expect(parsePin({ text: "no location here" })).toBeUndefined();
    expect(parsePin({})).toBeUndefined();
  });

  it("parses geo URIs", () => {
    expect(parseGeoUri("geo:37.786971,-122.399677;u=35")).toMatchObject({ lat: 37.786971, lng: -122.399677, source: "geo_uri" });
    expect(parsePinFromText("pin geo:-1.5,2.5")).toMatchObject({ lat: -1.5, lng: 2.5 });
  });

  it("recognises .loc.vcf names", () => {
    expect(isLocationVCardName("Current Location.loc.vcf")).toBe(true);
    expect(isLocationVCardName("Jane Doe.vcf")).toBe(false);
    expect(isLocationVCardName(undefined)).toBe(false);
  });

  it("validates ranges and unescapes vCard values", () => {
    expect(isValidLatLng(90, 180)).toBe(true);
    expect(isValidLatLng(-91, 0)).toBe(false);
    expect(isValidLatLng(Number.NaN, 1)).toBe(false);
    expect(unescapeVCardValue("a\\,b\\;c\\\\d")).toBe("a,b;c\\d");
  });
});
