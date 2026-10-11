// Channel over spectrum-ts (spec 8.5, 11.3, 11.4). The dialogue and the executor depend on the
// contracts Channel; this module implements it with:
//   - one cached DM space per E.164 (imessage(app).space.create, no network on the shared pool),
//   - sends that retry with backoff only on retryable errors: 3 attempts normally, 10 attempts
//     over about 5 min for safety-critical sends (L3 guardian alerts),
//   - typed non-retryable errors (TargetNotAllowedError, PoolNumberError, StoppedRecipientError,
//     QuotaExceededError, EmergencyNumberError) so callers can tell the user what happened,
//   - I14 stop checks at send time, I6 emergency-number refusal,
//   - Photon quotas tracked in the counters table (5,000 messages per day, 50 new conversations
//     per line per day); near the cap only safety sends proceed,
//   - tapbacks by message id from a bounded map of recent inbound Message objects,
//   - Notify Anyway: isFocusSilenced then messages.notifySilenced(chatGuid, guid). The Spectrum
//     message id IS the gRPC message guid (@spectrum-ts/imessage toMessageGuid is the identity;
//     on the shared pool it has the spc-msg-<uuid> form), so no listInChat lookup is needed.
import type { Channel, Clock, E164, SentRef } from "../contracts.js";
import type { Store } from "../store/db.js";
import * as repo from "../store/repo.js";
import {
  EmergencyNumberError,
  QuotaExceededError,
  StoppedRecipientError,
  describeError,
  isEmergencyNumber,
  last4,
  toTypedError,
} from "./errors.js";
import { dmChatGuid, toMessageGuid } from "./imessageAdvanced.js";

/** What the channel needs from a resolved space. Built from a spectrum-ts Space by spectrum.ts. */
export interface SpaceHandle {
  id: string;
  kind: "imessage" | "terminal";
  send(text: string): Promise<{ id: string; timestamp?: Date | undefined } | undefined>;
  responding<T>(fn: () => Promise<T>): Promise<T>;
  /** imessage(space).shareContactCard(); absent where the provider has no contact card. */
  shareContactCard?: () => Promise<void>;
}

export interface SpaceResolver {
  resolve(to: E164): Promise<SpaceHandle>;
}

/** Minimal Message surface for tapbacks. */
export interface Reactable {
  react(reaction: string): Promise<unknown>;
}

/** Subset of the advanced-imessage client used for Notify Anyway. */
export interface FocusApi {
  addresses: { isFocusSilenced(address: string): Promise<boolean> };
  messages: { notifySilenced(chat: string, message: string, options?: { readonly clientMessageId?: string }): Promise<void> };
}

export interface ChannelLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** Bounded insertion-ordered map (oldest evicted). */
export class BoundedMap<K, V> {
  private readonly m = new Map<K, V>();
  constructor(private readonly max: number) {}
  set(k: K, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
  }
  get(k: K): V | undefined {
    return this.m.get(k);
  }
  get size(): number {
    return this.m.size;
  }
}

// ---------- quotas (spec 8.5) ----------

export const QUOTA = { messagesPerDay: 5000, newConversationsPerDay: 50, nearRatio: 0.95 } as const;
export const COUNTER_MESSAGES = "msg_out";
export const COUNTER_NEW_CONVERSATIONS = "new_conv";

export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

export interface QuotaStatus {
  day: string;
  messages: number;
  newConversations: number;
  messagesNearCap: boolean;
  newConversationsNearCap: boolean;
}

export class QuotaGate {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly limits: { messagesPerDay: number; newConversationsPerDay: number; nearRatio: number } = QUOTA,
  ) {}

  status(): QuotaStatus {
    const day = dayKey(this.clock.now());
    const messages = repo.getCounter(this.store, day, COUNTER_MESSAGES);
    const newConversations = repo.getCounter(this.store, day, COUNTER_NEW_CONVERSATIONS);
    return {
      day,
      messages,
      newConversations,
      messagesNearCap: messages >= Math.floor(this.limits.messagesPerDay * this.limits.nearRatio),
      newConversationsNearCap: newConversations >= Math.floor(this.limits.newConversationsPerDay * this.limits.nearRatio),
    };
  }

  /** True when Batman has never exchanged a message with this address. */
  isNewConversation(to: E164): boolean {
    const r = this.store.sqlite.prepare("SELECT 1 AS x FROM messages WHERE address_e164 = ? LIMIT 1").get(to);
    return !r;
  }

  /** Throws QuotaExceededError when near a cap and the send is not safety-critical. */
  check(to: E164, safety: boolean): void {
    if (safety) return;
    const s = this.status();
    if (s.messagesNearCap) throw new QuotaExceededError(COUNTER_MESSAGES);
    if (s.newConversationsNearCap && this.isNewConversation(to)) throw new QuotaExceededError(COUNTER_NEW_CONVERSATIONS);
  }

  /** Dialogue hook (DialoguePorts.config.allowNewConversation). */
  allowNewConversation(): boolean {
    const s = this.status();
    return !s.messagesNearCap && !s.newConversationsNearCap;
  }

  record(newConversation: boolean): void {
    const day = dayKey(this.clock.now());
    repo.incrementCounter(this.store, day, COUNTER_MESSAGES);
    if (newConversation) repo.incrementCounter(this.store, day, COUNTER_NEW_CONVERSATIONS);
  }
}

// ---------- retries ----------

/** 3 attempts (spec 8.5). */
export const NORMAL_RETRY_DELAYS_MS = [1000, 3000] as const;
/** 10 attempts over 5 min for L3 guardian alerts (spec 8.5): waits sum to 300 s. */
export const CRITICAL_RETRY_DELAYS_MS = [5000, 10_000, 20_000, 30_000, 40_000, 45_000, 50_000, 50_000, 50_000] as const;

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { delays: readonly number[]; sleep: (ms: number) => Promise<void>; onRetry?: (attempt: number, err: unknown) => void },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const info = describeError(err);
      const delay = opts.delays[attempt - 1];
      if (!info.retryable || delay === undefined) throw err;
      opts.onRetry?.(attempt, err);
      await opts.sleep(Math.max(delay, info.retryAfterMs ?? 0));
    }
  }
}

// ---------- channel ----------

export interface SendOptions {
  /** L3 guardian alerts: 10 attempts over 5 min (spec 8.5). */
  critical?: boolean;
  /** Safety send: proceeds near the quota cap. Implied by critical. */
  safety?: boolean;
  /** Only for the single stop_ack after STOP (I14). */
  bypassStop?: boolean;
  /** messages.kind: template id or "text". Default "text". */
  kind?: string;
  planId?: string | null;
  /** Body to store; code words masked by the caller. Default: the text with digits runs redacted. */
  bodyRedacted?: string | null;
}

export interface GatewayChannelOptions {
  store: Store;
  clock: Clock;
  resolver: SpaceResolver;
  /** I14: address-level stop flag, checked at send time. */
  isStopped: (address: E164) => Promise<boolean> | boolean;
  quota?: QuotaGate;
  focus?: FocusApi | null;
  logger?: ChannelLogger;
  /** Real-time sleep for retry backoff (injected in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Max recent inbound messages kept for tapbacks. */
  recentMax?: number;
  /** Masks code words (and coordinates) in stored bodies when the caller gave none. */
  maskBody?: (to: E164, text: string) => string;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const noopLog: ChannelLogger = { info: () => {}, warn: () => {}, error: () => {} };
/** Emoji.like from spectrum-ts. */
const LIKE = "👍";

export class GatewayChannel implements Channel {
  private readonly spaces = new Map<string, Promise<SpaceHandle>>();
  private readonly recent: BoundedMap<string, Reactable>;
  readonly quota: QuotaGate;
  private readonly log: ChannelLogger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: GatewayChannelOptions) {
    this.recent = new BoundedMap(o.recentMax ?? 500);
    this.quota = o.quota ?? new QuotaGate(o.store, o.clock);
    this.log = o.logger ?? noopLog;
    this.sleep = o.sleep ?? realSleep;
  }

  /** Remember an inbound message so react(messageId) can find it (also under its parent id). */
  rememberInbound(id: string, m: Reactable, parentId?: string): void {
    this.recent.set(id, m);
    if (parentId) this.recent.set(parentId, m);
  }

  /** Cache the space an inbound message arrived in, keyed by its sender. */
  rememberSpace(from: E164, space: SpaceHandle): void {
    this.spaces.set(from, Promise.resolve(space));
  }

  private space(to: E164): Promise<SpaceHandle> {
    let p = this.spaces.get(to);
    if (!p) {
      p = this.o.resolver.resolve(to);
      this.spaces.set(to, p);
      p.catch(() => this.spaces.delete(to));
    }
    return p;
  }

  sendText(to: E164, text: string): Promise<SentRef> {
    return this.send(to, text, {});
  }

  async send(to: E164, text: string, opts: SendOptions): Promise<SentRef> {
    const safety = !!(opts.safety || opts.critical);
    if (isEmergencyNumber(to)) throw new EmergencyNumberError();
    if (!opts.bypassStop && (await this.o.isStopped(to))) {
      this.log.info({ to: last4(to), kind: opts.kind ?? "text" }, "send dropped: recipient stopped (I14)");
      throw new StoppedRecipientError(to.replace(/\D/g, "").slice(-4));
    }
    this.quota.check(to, safety);
    const newConversation = this.quota.isNewConversation(to);
    const space = await this.space(to);
    let sent: { id: string; timestamp?: Date | undefined } | undefined;
    try {
      sent = await withRetry(() => space.send(text), {
        delays: opts.critical ? CRITICAL_RETRY_DELAYS_MS : NORMAL_RETRY_DELAYS_MS,
        sleep: this.sleep,
        onRetry: (attempt, err) => this.log.warn({ to: last4(to), attempt, error: describeError(err) }, "send failed, retrying"),
      });
    } catch (err) {
      const info = describeError(err);
      if (opts.critical) this.log.error({ critical: true, to: last4(to), kind: opts.kind, error: info }, "CRITICAL: safety send failed after all retries");
      else this.log.warn({ to: last4(to), kind: opts.kind, error: info }, "send failed");
      throw toTypedError(err, to);
    }
    const at = sent?.timestamp instanceof Date ? sent.timestamp : this.o.clock.now();
    // The SDK resolves undefined when it skipped the content; keep a synthetic id so callers
    // still get a ref, but it can never match a reaction.
    const id = sent?.id ?? `local-${at.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    this.quota.record(newConversation);
    repo.recordMessage(this.o.store, {
      platformMessageId: id,
      direction: "outbound",
      addressE164: to,
      planId: opts.planId ?? null,
      kind: opts.kind ?? "text",
      bodyRedacted: opts.bodyRedacted === undefined ? (this.o.maskBody ? this.o.maskBody(to, text) : text) : opts.bodyRedacted,
      sentAt: at,
    });
    return { id, at };
  }

  async react(messageId: string, _emoji: "like"): Promise<void> {
    const m = this.recent.get(messageId);
    if (!m) {
      this.log.info({ messageId }, "react skipped: message not in recent inbound map");
      return;
    }
    try {
      await withRetry(() => m.react(LIKE), { delays: NORMAL_RETRY_DELAYS_MS, sleep: this.sleep });
    } catch (err) {
      this.log.warn({ messageId, error: describeError(err) }, "react failed");
    }
  }

  async typing<T>(to: E164, fn: () => Promise<T>): Promise<T> {
    let space: SpaceHandle;
    try {
      space = await this.space(to);
    } catch {
      return fn();
    }
    return space.responding(fn);
  }

  async shareContactCard(to: E164): Promise<void> {
    if (await this.o.isStopped(to)) return;
    const space = await this.space(to);
    if (!space.shareContactCard) {
      this.log.info({ to: last4(to), provider: space.kind }, "shareContactCard: not supported by provider, skipped");
      return;
    }
    try {
      await space.shareContactCard();
    } catch (err) {
      this.log.warn({ to: last4(to), error: describeError(err) }, "shareContactCard failed");
    }
  }

  /** Notify Anyway when the recipient's Focus is on. Never throws. */
  async notifyAnyway(to: E164, sent: SentRef): Promise<void> {
    const focus = this.o.focus;
    if (!focus) return;
    let space: SpaceHandle | undefined;
    try {
      space = await this.space(to);
    } catch {
      space = undefined;
    }
    if (space && space.kind !== "imessage") return;
    if (sent.id.startsWith("local-")) return;
    try {
      const silenced = await focus.addresses.isFocusSilenced(to);
      if (!silenced) return;
      const chat = space && space.id.startsWith("any;") ? space.id : dmChatGuid(to);
      await focus.messages.notifySilenced(chat, toMessageGuid(sent.id), { clientMessageId: `notify-${toMessageGuid(sent.id)}` });
      this.log.info({ to: last4(to) }, "notifySilenced sent");
    } catch (err) {
      this.log.warn({ to: last4(to), error: describeError(err) }, "notifyAnyway failed (ignored)");
    }
  }
}
