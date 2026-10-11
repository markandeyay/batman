// Geocoding (spec 4.4.2 venueGeo, 7.2, 19 GEOCODER). Nominatim is the default (free, needs a
// contact in the User-Agent and at most 1 request per second). Mapbox and Google sit behind the
// same interface. Failures return [] / null: venue geo is optional (time-only watching).
// Mapbox (geocoding v5 places) and Google (Geocoding API json) request shapes follow their
// long-standing public APIs; they have not been exercised live in this repo yet.

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  /** Provider place type, normalized loosely: "house", "address", "poi", "street", "city", ... */
  placeType: string | null;
  /** True when the result looks like a residence (spec 4.4.4 marketplace private address). */
  residential: boolean;
}

export interface GeocodeOptions {
  /** Bias results toward this point (user's last fix or home). */
  near?: { lat: number; lng: number } | null;
  /** ISO 3166-1 alpha-2 codes, e.g. ["us"]. */
  countryCodes?: string[];
  limit?: number;
}

export interface Geocoder {
  readonly name: string;
  geocode(query: string, opts?: GeocodeOptions): Promise<GeocodeResult[]>;
  reverse(lat: number, lng: number): Promise<string | null>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface HttpDeps {
  fetch?: FetchLike;
  /** Milliseconds clock and sleep, injectable for tests. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers, signal: ac.signal });
    if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const RESIDENTIAL_TYPES = new Set(["house", "residential", "apartments", "detached", "semidetached_house", "terrace", "dormitory", "address", "premise", "subpremise", "street_address", "building"]);

// ---------- Nominatim ----------

export class NominatimGeocoder implements Geocoder {
  readonly name = "nominatim";
  private readonly fetchFn: FetchLike;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  /** Nominatim usage policy: at most 1 request per second. */
  static readonly MIN_INTERVAL_MS = 1000;

  constructor(
    private readonly opts: { userAgent: string; baseUrl?: string } & HttpDeps,
  ) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.nowMs = opts.nowMs ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /** Serialize requests and keep them at least MIN_INTERVAL_MS apart. */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.lastRequestAt + NominatimGeocoder.MIN_INTERVAL_MS - this.nowMs();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.nowMs();
      return fn();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private get base(): string {
    return this.opts.baseUrl ?? "https://nominatim.openstreetmap.org";
  }

  private get headers(): Record<string, string> {
    return { "User-Agent": this.opts.userAgent, "Accept-Language": "en" };
  }

  async geocode(query: string, opts: GeocodeOptions = {}): Promise<GeocodeResult[]> {
    const q = query.trim();
    if (!q) return [];
    const params = new URLSearchParams({ q, format: "jsonv2", limit: String(opts.limit ?? 3), addressdetails: "0" });
    if (opts.countryCodes?.length) params.set("countrycodes", opts.countryCodes.join(","));
    if (opts.near) {
      const d = 0.25;
      params.set("viewbox", `${opts.near.lng - d},${opts.near.lat + d},${opts.near.lng + d},${opts.near.lat - d}`);
    }
    try {
      const data = await this.throttled(() => getJson(this.fetchFn, `${this.base}/search?${params}`, this.headers, this.timeoutMs));
      if (!Array.isArray(data)) return [];
      return data
        .map((r: Record<string, unknown>) => {
          const lat = Number(r.lat);
          const lng = Number(r.lon);
          const type = typeof r.type === "string" ? r.type : null;
          const addresstype = typeof r.addresstype === "string" ? r.addresstype : null;
          const category = typeof r.category === "string" ? r.category : null;
          return {
            lat,
            lng,
            displayName: typeof r.display_name === "string" ? r.display_name : q,
            placeType: addresstype ?? type,
            residential:
              (type !== null && RESIDENTIAL_TYPES.has(type) && category !== "amenity" && category !== "shop") ||
              addresstype === "house" ||
              addresstype === "building",
          };
        })
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    } catch {
      return [];
    }
  }

  async reverse(lat: number, lng: number): Promise<string | null> {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: "jsonv2", zoom: "18" });
    try {
      const data = (await this.throttled(() => getJson(this.fetchFn, `${this.base}/reverse?${params}`, this.headers, this.timeoutMs))) as Record<string, unknown>;
      return typeof data?.display_name === "string" ? shortAddress(data.display_name) : null;
    } catch {
      return null;
    }
  }
}

/** "1820, North Milwaukee Avenue, Bucktown, Chicago, Cook County, Illinois, 60647, United States" -> first 3 parts. */
export function shortAddress(display: string): string {
  const parts = display.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && /^\d+[a-z]?$/i.test(parts[0]!)) parts.splice(0, 2, `${parts[0]} ${parts[1]}`);
  return parts.slice(0, 3).join(", ");
}

// ---------- Mapbox (geocoding v5 places) ----------

export class MapboxGeocoder implements Geocoder {
  readonly name = "mapbox";
  private readonly fetchFn: FetchLike;
  constructor(private readonly opts: { accessToken: string } & HttpDeps) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }
  async geocode(query: string, opts: GeocodeOptions = {}): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({ access_token: this.opts.accessToken, limit: String(opts.limit ?? 3) });
    if (opts.countryCodes?.length) params.set("country", opts.countryCodes.join(","));
    if (opts.near) params.set("proximity", `${opts.near.lng},${opts.near.lat}`);
    try {
      const data = (await getJson(
        this.fetchFn,
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params}`,
        {},
        this.opts.timeoutMs ?? 8000,
      )) as { features?: Array<{ center?: [number, number]; place_name?: string; place_type?: string[] }> };
      return (data.features ?? [])
        .filter((f) => Array.isArray(f.center))
        .map((f) => {
          const pt = f.place_type?.[0] ?? null;
          return { lat: f.center![1], lng: f.center![0], displayName: f.place_name ?? query, placeType: pt, residential: pt === "address" };
        });
    } catch {
      return [];
    }
  }
  async reverse(lat: number, lng: number): Promise<string | null> {
    const params = new URLSearchParams({ access_token: this.opts.accessToken, limit: "1" });
    try {
      const data = (await getJson(this.fetchFn, `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?${params}`, {}, this.opts.timeoutMs ?? 8000)) as {
        features?: Array<{ place_name?: string }>;
      };
      const name = data.features?.[0]?.place_name;
      return name ? shortAddress(name) : null;
    } catch {
      return null;
    }
  }
}

// ---------- Google (Geocoding API) ----------

export class GoogleGeocoder implements Geocoder {
  readonly name = "google";
  private readonly fetchFn: FetchLike;
  constructor(private readonly opts: { apiKey: string } & HttpDeps) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }
  async geocode(query: string, opts: GeocodeOptions = {}): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({ address: query, key: this.opts.apiKey });
    if (opts.countryCodes?.length) params.set("components", opts.countryCodes.map((c) => `country:${c}`).join("|"));
    if (opts.near) {
      const d = 0.25;
      params.set("bounds", `${opts.near.lat - d},${opts.near.lng - d}|${opts.near.lat + d},${opts.near.lng + d}`);
    }
    try {
      const data = (await getJson(this.fetchFn, `https://maps.googleapis.com/maps/api/geocode/json?${params}`, {}, this.opts.timeoutMs ?? 8000)) as {
        results?: Array<{ formatted_address?: string; types?: string[]; geometry?: { location?: { lat: number; lng: number } } }>;
      };
      return (data.results ?? [])
        .slice(0, opts.limit ?? 3)
        .filter((r) => r.geometry?.location)
        .map((r) => {
          const types = r.types ?? [];
          return {
            lat: r.geometry!.location!.lat,
            lng: r.geometry!.location!.lng,
            displayName: r.formatted_address ?? query,
            placeType: types[0] ?? null,
            residential: types.some((t) => t === "street_address" || t === "premise" || t === "subpremise") && !types.includes("establishment"),
          };
        });
    } catch {
      return [];
    }
  }
  async reverse(lat: number, lng: number): Promise<string | null> {
    const params = new URLSearchParams({ latlng: `${lat},${lng}`, key: this.opts.apiKey });
    try {
      const data = (await getJson(this.fetchFn, `https://maps.googleapis.com/maps/api/geocode/json?${params}`, {}, this.opts.timeoutMs ?? 8000)) as {
        results?: Array<{ formatted_address?: string }>;
      };
      const a = data.results?.[0]?.formatted_address;
      return a ? shortAddress(a) : null;
    } catch {
      return null;
    }
  }
}

/** Geocoder that never finds anything (tests, offline). */
export class NullGeocoder implements Geocoder {
  readonly name = "null";
  async geocode(): Promise<GeocodeResult[]> {
    return [];
  }
  async reverse(): Promise<string | null> {
    return null;
  }
}

export interface GeocoderEnv {
  GEOCODER?: string | undefined;
  GEOCODER_API_KEY?: string | undefined;
  /** Contact (email or URL) for the Nominatim User-Agent. Falls back to GEOCODER_API_KEY. */
  GEOCODER_CONTACT?: string | undefined;
}

export function createGeocoder(env: GeocoderEnv, deps: HttpDeps = {}): Geocoder {
  const kind = (env.GEOCODER ?? "nominatim").trim().toLowerCase();
  const key = env.GEOCODER_API_KEY?.trim() ?? "";
  if (kind === "mapbox") {
    if (!key) throw new Error("GEOCODER=mapbox needs GEOCODER_API_KEY");
    return new MapboxGeocoder({ accessToken: key, ...deps });
  }
  if (kind === "google") {
    if (!key) throw new Error("GEOCODER=google needs GEOCODER_API_KEY");
    return new GoogleGeocoder({ apiKey: key, ...deps });
  }
  if (kind !== "nominatim") throw new Error(`Unknown GEOCODER "${kind}"`);
  const contact = env.GEOCODER_CONTACT?.trim() || key;
  const userAgent = `BatmanSafetyAgent/0.1${contact ? ` (${contact})` : ""}`;
  return new NominatimGeocoder({ userAgent, ...deps });
}
