// Find My location source over advanced-imessage (spec 7.1; Spike S1 PASS on the shared pool).
//
// - watch(address) is the primary stream (33 updates in a 7 min walk). Updates missed during a
//   disconnect are not replayed, so reconnect with backoff 1, 2, 4, 8, max 30 s and dedupe on
//   sourceSequence.
// - get(address) every 60 s is the heartbeat: it catches a silently dropped stream and is the
//   only way to detect acceptance (NotFoundError until shared).
// - get() NOT_FOUND "[upstream] Address is not currently sharing a location" means the share
//   ended: onShareEnded fires once (the executor treats it as location_not_shared).
// - I2: every location is checked against the user's exact address before it becomes a Fix.
//   locations.list() is never called (unusable on shared tokens and the only cross-user read).
import type { Clock, E164, Fix, LocationSource } from "../contracts.js";
import { describeError, isNotFound, isShareEnded } from "../gateway/errors.js";
import { belongsToUser } from "./source.js";

/** Structural subset of SharedFriendLocation (@photon-ai/advanced-imessage 2.2.0). */
export interface FriendLocation {
  readonly accuracy?: number | undefined;
  readonly address: string;
  readonly expiresAt?: Date | undefined;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
  readonly locationTimestamp?: Date | undefined;
  readonly locationType: "legacy" | "live" | "shallow" | "unknown";
}

export interface FriendLocationUpdated {
  readonly location: FriendLocation;
  readonly sourceSequence: number;
}

export interface WatchStream extends AsyncIterable<FriendLocationUpdated> {
  close(): void | Promise<void>;
}

/** Only get, request and watch. list() is deliberately absent from this type (I2). */
export interface LocationsApi {
  get(address: string): Promise<FriendLocation>;
  request(chat: string, address: string, options?: { readonly clientMessageId?: string }): Promise<{ status: string; address?: string; messageGuid?: string }>;
  watch(address?: string): WatchStream;
}

export interface FindMyLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;
export const HEARTBEAT_MS = 60_000;
/** Accuracy reported when Photon omits it: large enough that the risk engine treats it as poor. */
export const UNKNOWN_ACCURACY_M = 1000;

/** Convert one location to a Fix if it belongs to the user (I2) and has both coordinates. */
export function toFix(loc: FriendLocation, userAddress: E164, receivedAt: Date): Fix | null {
  if (!belongsToUser(loc.address, userAddress)) return null;
  if (typeof loc.latitude !== "number" || typeof loc.longitude !== "number") return null;
  if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return null;
  return {
    lat: loc.latitude,
    lng: loc.longitude,
    accuracyM: typeof loc.accuracy === "number" && loc.accuracy >= 0 ? loc.accuracy : UNKNOWN_ACCURACY_M,
    at: loc.locationTimestamp instanceof Date ? loc.locationTimestamp : receivedAt,
    locationType: loc.locationType,
    expiresAt: loc.expiresAt instanceof Date ? loc.expiresAt : null,
    source: "findmy",
  };
}

export interface ShareProbe {
  visible: boolean;
  expiresAt: Date | null;
}

/** Acceptance check (spec 4.5): get() succeeds with coordinates once the user shares. */
export async function probeShare(api: Pick<LocationsApi, "get">, userAddress: E164): Promise<ShareProbe> {
  try {
    const loc = await api.get(userAddress);
    if (!belongsToUser(loc.address, userAddress)) return { visible: false, expiresAt: null };
    const visible = typeof loc.latitude === "number" && typeof loc.longitude === "number";
    return { visible, expiresAt: loc.expiresAt instanceof Date ? loc.expiresAt : null };
  } catch (err) {
    if (isNotFound(err)) return { visible: false, expiresAt: null };
    throw err;
  }
}

/** Poll get() every 30 s up to 15 min until the share is visible. Resolves the last probe. */
export async function pollForAcceptance(
  api: Pick<LocationsApi, "get">,
  userAddress: E164,
  opts: { clock: Clock; intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; onError?: (err: unknown) => void },
): Promise<ShareProbe> {
  const interval = opts.intervalMs ?? 30_000;
  const deadline = opts.clock.now().getTime() + (opts.timeoutMs ?? 15 * 60_000);
  let last: ShareProbe = { visible: false, expiresAt: null };
  for (;;) {
    if (opts.signal?.aborted) return last;
    try {
      last = await probeShare(api, userAddress);
      if (last.visible) return last;
    } catch (err) {
      opts.onError?.(err);
    }
    if (opts.clock.now().getTime() + interval > deadline) return last;
    await opts.clock.sleep(interval);
  }
}

export interface FindMyOptions {
  api: LocationsApi;
  clock: Clock;
  /** Called once when get() reports the share ended (NOT_FOUND "not currently sharing"). */
  onShareEnded?: () => void;
  logger?: FindMyLogger;
  heartbeatMs?: number;
  backoffMs?: readonly number[];
}

const noop: FindMyLogger = { info: () => {}, warn: () => {} };

/** One instance watches one user (LocationSource.stop() takes no address). */
export class FindMyLocationSource implements LocationSource {
  private running = false;
  private userAddress: E164 | null = null;
  private onFix: ((fix: Fix, fromAddress: E164) => void) | null = null;
  private stream: WatchStream | null = null;
  private stopWaiters: (() => void)[] = [];
  private readonly seenSeq = new Set<number>();
  private readonly seqOrder: number[] = [];
  private lastKey: string | null = null;
  private shareEnded = false;
  private readonly log: FindMyLogger;
  private loops: Promise<void>[] = [];
  /** Counters for tests and /state. */
  readonly stats = { streamUpdates: 0, heartbeatFixes: 0, duplicates: 0, rejectedOtherAddress: 0, reconnects: 0 };

  constructor(private readonly o: FindMyOptions) {
    this.log = o.logger ?? noop;
  }

  async start(userAddress: E164, onFix: (fix: Fix, fromAddress: E164) => void): Promise<void> {
    if (this.running) await this.stop();
    this.running = true;
    this.userAddress = userAddress;
    this.onFix = onFix;
    this.shareEnded = false;
    this.loops = [this.watchLoop(), this.heartbeatLoop()];
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.onFix = null;
    const s = this.stream;
    this.stream = null;
    try {
      await s?.close();
    } catch {
      // closing a dead stream is fine
    }
    for (const w of this.stopWaiters.splice(0)) w();
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Sleep on the clock, cut short by stop(). */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.stopWaiters.push(finish);
      void this.o.clock.sleep(ms).then(finish);
    });
  }

  private emit(loc: FriendLocation, seq: number | null): void {
    const user = this.userAddress;
    const cb = this.onFix;
    if (!this.running || !user || !cb) return;
    if (!belongsToUser(loc.address, user)) {
      this.stats.rejectedOtherAddress++;
      return; // I2: never forward, never store
    }
    if (seq !== null) {
      if (this.seenSeq.has(seq)) {
        this.stats.duplicates++;
        return;
      }
      this.seenSeq.add(seq);
      this.seqOrder.push(seq);
      if (this.seqOrder.length > 512) this.seenSeq.delete(this.seqOrder.shift()!);
    }
    const fix = toFix(loc, user, this.o.clock.now());
    if (!fix) return;
    const key = `${fix.at.getTime()}|${fix.lat}|${fix.lng}`;
    if (key === this.lastKey) {
      this.stats.duplicates++;
      return;
    }
    this.lastKey = key;
    if (this.shareEnded) this.shareEnded = false; // sharing resumed
    if (seq === null) this.stats.heartbeatFixes++;
    else this.stats.streamUpdates++;
    try {
      cb(fix, loc.address as E164);
    } catch (err) {
      this.log.warn({ error: describeError(err) }, "findmy: onFix handler threw");
    }
  }

  private async watchLoop(): Promise<void> {
    const backoff = this.o.backoffMs ?? RECONNECT_BACKOFF_MS;
    let failures = 0;
    while (this.running) {
      let gotAny = false;
      try {
        const stream = this.o.api.watch(this.userAddress!);
        this.stream = stream;
        for await (const u of stream) {
          if (!this.running) break;
          gotAny = true;
          failures = 0;
          this.emit(u.location, u.sourceSequence);
        }
        if (!this.running) break;
        this.log.info({}, "findmy: watch stream ended, reconnecting");
      } catch (err) {
        if (!this.running) break;
        this.log.warn({ error: describeError(err) }, "findmy: watch stream error, reconnecting");
      }
      this.stream = null;
      if (!gotAny) failures++;
      const delay = backoff[Math.min(Math.max(0, failures - 1), backoff.length - 1)] ?? 30_000;
      this.stats.reconnects++;
      await this.wait(delay);
    }
  }

  private async heartbeatLoop(): Promise<void> {
    const every = this.o.heartbeatMs ?? HEARTBEAT_MS;
    while (this.running) {
      await this.wait(every);
      if (!this.running) break;
      try {
        const loc = await this.o.api.get(this.userAddress!);
        this.emit(loc, null);
      } catch (err) {
        if (isShareEnded(err) || isNotFound(err)) {
          if (!this.shareEnded) {
            this.shareEnded = true;
            this.log.info({}, "findmy: share ended (get NOT_FOUND)");
            try {
              this.o.onShareEnded?.();
            } catch (cbErr) {
              this.log.warn({ error: describeError(cbErr) }, "findmy: onShareEnded threw");
            }
          }
        } else {
          this.log.warn({ error: describeError(err) }, "findmy: heartbeat get failed");
        }
      }
    }
  }
}
