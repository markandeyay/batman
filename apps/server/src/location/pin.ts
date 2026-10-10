// Location pin parser (spec 7.1 "pin" source, 8.4 step 6, Spike S4).
//
// Pure functions, no I/O. Inputs come from spectrum-ts content:
//   - `contact` content: `urls?: string[]` plus `raw?: unknown` (the vCard text; core fromVCard sets raw = vcf)
//   - `attachment` content whose bytes are a vCard (`.loc.vcf`, `text/vcard`) when the SDK could not parse it
//   - `text` content that contains a maps link (some share sheets send a plain URL)
//
// Formats handled (plausible from installed types and PHOTON_NOTES; the exact iOS format is what
// Spike S4 records):
//   - Apple Maps URLs: maps.apple.com/?ll=LAT,LNG, ?q=LAT,LNG, ?sll=, ?daddr=, ?center=,
//     /place?coordinate=LAT,LNG
//   - Google Maps URLs: ?q=LAT,LNG, ?query=LAT,LNG, /@LAT,LNG,ZOOMz
//   - Apple "Current Location" .loc.vcf: item1.URL;type=pref:http://maps.apple.com/?ll=LAT\,LNG&q=...
//     (vCard 3.0 escapes the comma as "\,", and long lines may be folded)
//   - vCard GEO: "GEO:LAT;LNG" (3.0) and "GEO:geo:LAT,LNG" (4.0)
//   - RFC 5870 geo URIs: geo:LAT,LNG
// Short links with no coordinates (maps.apple/p/..., goo.gl/...) return undefined; never fetch them.

export type PinSource = "maps_url" | "vcard_geo" | "geo_uri";

export interface PinCoords {
  lat: number;
  lng: number;
  source: PinSource;
  /** Which field produced the coordinates, e.g. "ll", "coordinate", "@", "GEO". */
  field: string;
}

export interface VCardPin {
  /** Coordinates if any maps URL or GEO line carried them. */
  coords?: PinCoords;
  /** All URL values in the card, unescaped. */
  urls: string[];
  /** FN value, if present. */
  name?: string;
  /** True when this looks like an Apple location card ("Current Location", a "map url" label, or coordinates). */
  isLocationCard: boolean;
}

export interface PinInput {
  text?: string | undefined;
  urls?: readonly string[] | undefined;
  vcf?: string | undefined;
}

const NUM = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;
const PAIR_EXACT = new RegExp(String.raw`^\s*(${NUM})\s*,\s*(${NUM})\s*$`);
const PAIR_AT = new RegExp(String.raw`@(${NUM}),(${NUM})(?:[,/z]|$)`);
const GEO_VALUE = new RegExp(String.raw`^(${NUM})\s*[;,]\s*(${NUM})`);
const GEO_URI = new RegExp(String.raw`\bgeo:(${NUM}),(${NUM})`, "i");
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"]+/gi;

export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

function pair(lat: string | undefined, lng: string | undefined, source: PinSource, field: string): PinCoords | undefined {
  if (lat === undefined || lng === undefined) return undefined;
  const a = Number(lat);
  const b = Number(lng);
  return isValidLatLng(a, b) ? { lat: a, lng: b, source, field } : undefined;
}

function isMapsHost(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  if (host === "maps.apple.com" || host === "maps.apple" || host.endsWith(".maps.apple.com")) return true;
  if (/^maps\.google\.[a-z.]+$/.test(host)) return true;
  if (/^(www\.)?google\.[a-z.]+$/.test(host) && u.pathname.startsWith("/maps")) return true;
  return false;
}

/** vCard 3.0 text escaping: "\," "\;" "\:" "\\" and "\n". */
export function unescapeVCardValue(v: string): string {
  return v.replace(/\\([,;:\\nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** RFC 5870 geo URI anywhere in the string ("geo:37.33,-122.03;u=35"). */
export function parseGeoUri(s: string): PinCoords | undefined {
  const m = GEO_URI.exec(s);
  return m ? pair(m[1], m[2], "geo_uri", "geo") : undefined;
}

/** Coordinates from an Apple Maps or Google Maps URL (or a geo: URI), or undefined. */
export function parseMapsUrl(raw: string): PinCoords | undefined {
  const cleaned = unescapeVCardValue(raw.trim());
  if (/^geo:/i.test(cleaned)) return parseGeoUri(cleaned);
  let u: URL;
  try {
    u = new URL(cleaned);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (!isMapsHost(u)) return undefined;
  // Order matters: ll / coordinate are the pin itself; q may be a label; sll is a search center.
  for (const key of ["ll", "coordinate", "q", "query", "daddr", "sll", "center"]) {
    const v = u.searchParams.get(key);
    if (!v) continue;
    const m = PAIR_EXACT.exec(v.replace(/\\/g, ""));
    if (m) {
      const p = pair(m[1], m[2], "maps_url", key);
      if (p) return p;
    }
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw path */
  }
  const at = PAIR_AT.exec(path);
  return at ? pair(at[1], at[2], "maps_url", "@") : undefined;
}

/** Unfold RFC 6350 / 2425 continuation lines (CRLF followed by a space or tab). */
function unfold(vcf: string): string[] {
  return vcf.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

interface VCardLine {
  group?: string;
  name: string;
  value: string;
}

function parseLine(line: string): VCardLine | undefined {
  // [group.]NAME[;params]:value  (the value may contain ':' so split on the first one after params)
  const m = /^(?:([A-Za-z0-9-]+)\.)?([A-Za-z0-9-]+)(?:;[^:]*)?:(.*)$/.exec(line.trim());
  if (!m) return undefined;
  const out: VCardLine = { name: m[2]!.toUpperCase(), value: m[3] ?? "" };
  if (m[1]) out.group = m[1].toLowerCase();
  return out;
}

function parseGeoLine(value: string): PinCoords | undefined {
  const v = value.trim();
  if (/^geo:/i.test(v)) {
    const g = parseGeoUri(v);
    return g ? { ...g, source: "vcard_geo", field: "GEO" } : undefined;
  }
  const m = GEO_VALUE.exec(unescapeVCardValue(v));
  return m ? pair(m[1], m[2], "vcard_geo", "GEO") : undefined;
}

/** Parse a vCard (Apple .loc.vcf or a regular contact card) for a location. */
export function parseVCardPin(vcf: string): VCardPin {
  const urls: string[] = [];
  const labels: string[] = [];
  let name: string | undefined;
  let geo: PinCoords | undefined;
  for (const raw of unfold(vcf)) {
    const l = parseLine(raw);
    if (!l) continue;
    if (l.name === "URL") urls.push(unescapeVCardValue(l.value.trim()));
    else if (l.name === "FN") name = unescapeVCardValue(l.value.trim());
    else if (l.name === "X-ABLABEL") labels.push(l.value.trim().toLowerCase());
    else if (l.name === "GEO") geo ??= parseGeoLine(l.value);
  }
  let coords: PinCoords | undefined;
  for (const u of urls) {
    coords = parseMapsUrl(u);
    if (coords) break;
  }
  coords ??= geo;
  const isLocationCard =
    (name ?? "").trim().toLowerCase() === "current location" ||
    labels.some((v) => v.includes("map")) ||
    coords !== undefined;
  const out: VCardPin = { urls, isLocationCard };
  if (coords) out.coords = coords;
  if (name !== undefined) out.name = name;
  return out;
}

/** First maps URL or geo URI in free text. */
export function parsePinFromText(text: string): PinCoords | undefined {
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const p = parseMapsUrl(m[0].replace(/[).,;!?']+$/, ""));
    if (p) return p;
  }
  return parseGeoUri(text);
}

/** True for Apple's location card file names ("Current Location.loc.vcf", "Dropped Pin.loc.vcf"). */
export function isLocationVCardName(fileName: string | undefined): boolean {
  return !!fileName && /\.loc\.vcf$/i.test(fileName.trim());
}

/**
 * One entry point for the inbound pipeline: tries explicit URLs (contact.urls), then the raw
 * vCard, then free text. Returns undefined when nothing carries coordinates.
 */
export function parsePin(input: PinInput): PinCoords | undefined {
  for (const u of input.urls ?? []) {
    const p = parseMapsUrl(u);
    if (p) return p;
  }
  if (input.vcf) {
    const v = parseVCardPin(input.vcf);
    if (v.coords) return v.coords;
  }
  return input.text ? parsePinFromText(input.text) : undefined;
}
