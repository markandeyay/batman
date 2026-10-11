// Spectrum init, the inbound loop, and the iMessage space resolver (spec 8.4, 11.2).
//
// - Providers: the iMessage cloud provider; the terminal provider only when ENABLE_TERMINAL.
//   Never @spectrum-ts/imessage-local.
// - imessage.config() needs a cast in spectrum-ts 12.10.1 (its parameter resolves to never;
//   docs/spikes/S3_S4.md open question 1). Runtime takes {} as documented.
// - The loop never throws out: a handler error is logged, a stream error restarts the
//   iteration after a short delay. Outbound echoes and read receipts are skipped, then every
//   message id is deduped through processed_inbound (store/repo.ts) before normalization.
// - Messages are handled serially per sender and concurrently across senders, so one slow LLM
//   call never delays another person's code word.
// - Spectrum registers no signal handlers: installSignalHandlers wires SIGINT, SIGBREAK, SIGTERM.
import { Spectrum, type Message, type PlatformProviderConfig, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Clock, E164 } from "../contracts.js";
import type { Store } from "../store/db.js";
import * as repo from "../store/repo.js";
import type { SpaceHandle, SpaceResolver } from "./channel.js";
import { describeError, last4 } from "./errors.js";
import { normalizeInbound, type NormalizeOptions, type NormalizedInbound, type RawMessage } from "./normalize.js";

export type SpectrumLogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** What the gateway uses from a SpectrumInstance (tests pass a fake). */
export interface SpectrumApp {
  readonly messages: AsyncIterable<[Space, Message]>;
  stop(): Promise<void>;
}

export interface StartSpectrumOptions {
  projectId: string;
  projectSecret: string;
  logLevel: SpectrumLogLevel;
  /** Include the iMessage cloud provider. Default true. */
  imessage?: boolean;
  /** ENABLE_TERMINAL: add the terminal provider (dev only). */
  terminal?: boolean;
  /** Slash commands shown by the terminal UI. */
  terminalCommands?: { name: string; description?: string }[];
}

export async function startSpectrum(o: StartSpectrumOptions): Promise<SpectrumApp> {
  const providers: PlatformProviderConfig[] = [];
  if (o.imessage !== false) {
    const imessageConfig = imessage.config as unknown as (cfg?: Record<string, never>) => PlatformProviderConfig;
    providers.push(imessageConfig({}));
  }
  if (o.terminal) {
    const { terminal } = await import("spectrum-ts/providers/terminal");
    const terminalConfig = terminal.config as unknown as (cfg?: { commands?: { name: string; description?: string }[] }) => PlatformProviderConfig;
    providers.push(terminalConfig(o.terminalCommands ? { commands: o.terminalCommands } : {}));
  }
  if (providers.length === 0) throw new Error("no Spectrum providers enabled");
  const app = await Spectrum({ projectId: o.projectId, projectSecret: o.projectSecret, providers, options: { logLevel: o.logLevel } });
  return app as unknown as SpectrumApp;
}

/** Adapt a spectrum-ts Space to the Channel's SpaceHandle. */
export function toSpaceHandle(space: Space, kind: "imessage" | "terminal"): SpaceHandle {
  const handle: SpaceHandle = {
    id: space.id,
    kind,
    send: async (text: string) => {
      const m = await space.send(text);
      if (!m) return undefined;
      return { id: m.id, timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp) };
    },
    responding: <T>(fn: () => Promise<T>) => space.responding(fn),
  };
  if (kind === "imessage") {
    // Verified in installed @spectrum-ts/imessage 12.10.1 types: PlatformSpace actions include
    // shareContactCard(space) -> chats.shareContactInfo(chatGuid). Shared mode supported.
    handle.shareContactCard = async () => {
      const s = imessage(space) as unknown as { shareContactCard?: () => Promise<void> };
      if (typeof s.shareContactCard !== "function") throw new Error("shareContactCard not available on this space");
      await s.shareContactCard();
    };
  }
  return handle;
}

/** iMessage DM resolver: imessage(app).space.create(e164); on the shared pool this is local. */
export function imessageResolver(app: SpectrumApp): SpaceResolver {
  return {
    async resolve(to: E164): Promise<SpaceHandle> {
      const im = imessage(app as never) as unknown as { space: { create(user: string): Promise<Space> } };
      const space = await im.space.create(to);
      return toSpaceHandle(space, "imessage");
    },
  };
}

export interface InboundLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export type InboundHandler = (msg: NormalizedInbound) => Promise<void>;

/** Raw message plus the methods the channel needs later (react). */
export type LoopMessage = RawMessage & { react(reaction: string): Promise<unknown> };

export interface InboundLoopOptions {
  messages: AsyncIterable<[Space, Message]> | AsyncIterable<[unknown, LoopMessage]>;
  store: Store;
  clock: Clock;
  normalize: Omit<NormalizeOptions, "resolveFrom">;
  /** Platform-aware sender mapping (terminal ids map to configured test numbers). */
  resolveFrom: (m: RawMessage) => E164 | null;
  handler: () => InboundHandler;
  /** Consume a message before dedupe and normalization (terminal /as commands). */
  intercept?: (m: RawMessage, space: unknown) => Promise<boolean>;
  /** Called for each accepted inbound message (cache its space and Message for replies). */
  onAccepted?: (from: E164, space: unknown, m: LoopMessage) => void;
  logger?: InboundLogger;
  restartDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const quiet: InboundLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export class InboundLoop {
  private running = false;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly log: InboundLogger;
  private done: Promise<void> | null = null;
  /** Counters for tests. */
  readonly stats = { received: 0, duplicates: 0, skipped: 0, handled: 0, handlerErrors: 0, streamErrors: 0 };

  constructor(private readonly o: InboundLoopOptions) {
    this.log = o.logger ?? quiet;
  }

  start(): Promise<void> {
    if (this.running) return this.done ?? Promise.resolve();
    this.running = true;
    this.done = this.run();
    return this.done;
  }

  stop(): void {
    this.running = false;
  }

  /** Wait for in-flight handlers (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.queues.size > 0) await Promise.allSettled([...this.queues.values()]);
  }

  private async run(): Promise<void> {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while (this.running) {
      try {
        for await (const pair of this.o.messages as AsyncIterable<[unknown, LoopMessage]>) {
          if (!this.running) break;
          await this.accept(pair[0], pair[1]);
        }
        if (!this.running) break;
        this.log.warn({}, "inbound stream ended; restarting");
      } catch (err) {
        this.stats.streamErrors++;
        this.log.error({ error: describeError(err) }, "inbound stream error; restarting");
      }
      if (this.running) await sleep(this.o.restartDelayMs ?? 2000);
    }
  }

  /** One message: skip, dedupe, normalize, then hand off. Never throws. */
  async accept(space: unknown, m: LoopMessage): Promise<void> {
    try {
      this.stats.received++;
      if (m.direction === "outbound") {
        this.stats.skipped++;
        return;
      }
      if (m.content?.type === "read") {
        // 8.4 step 3: delivery signal only. Never reply to a read receipt.
        this.stats.skipped++;
        this.log.debug({ id: m.id }, "read receipt");
        return;
      }
      if (this.o.intercept && (await this.o.intercept(m, space))) {
        this.stats.skipped++;
        return;
      }
      const now = this.o.clock.now();
      if (!repo.markInboundProcessed(this.o.store, m.id, now)) {
        this.stats.duplicates++;
        return;
      }
      const from = this.o.resolveFrom(m);
      if (!from) {
        this.stats.skipped++;
        this.log.info({ id: m.id, platform: m.platform }, "inbound without an E.164 sender ignored");
        return;
      }
      this.o.onAccepted?.(from, space, m);
      const key = from;
      const prev = this.queues.get(key) ?? Promise.resolve();
      const next = prev.then(() => this.process(m, from));
      this.queues.set(key, next);
      void next.then(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    } catch (err) {
      this.log.error({ id: m?.id, error: describeError(err) }, "inbound accept failed");
    }
  }

  private async process(m: LoopMessage, from: E164): Promise<void> {
    try {
      const n = await normalizeInbound(m, { ...this.o.normalize, resolveFrom: () => from });
      if (!n) {
        this.stats.skipped++;
        return;
      }
      try {
        repo.recordMessage(this.o.store, {
          platformMessageId: n.rawId,
          direction: "inbound",
          addressE164: from,
          kind: n.message.content.kind,
          bodyRedacted: null, // inbound text is never stored (it may hold code words)
          sentAt: n.message.at,
        });
      } catch (err) {
        this.log.warn({ error: describeError(err) }, "inbound message row failed");
      }
      this.log.info({ id: n.message.id, from: last4(from), kind: n.message.content.kind, platform: n.platform }, "inbound");
      await this.o.handler()(n);
      this.stats.handled++;
    } catch (err) {
      this.stats.handlerErrors++;
      this.log.error({ id: m.id, from: last4(from), error: describeError(err) }, "inbound handler failed");
    }
  }
}

/** spec 8.1 / 11.2: stop on SIGINT, SIGBREAK (Windows Ctrl+Break) and SIGTERM. Returns an uninstaller. */
export function installSignalHandlers(stop: (signal: string) => void | Promise<void>): () => void {
  const installed: [NodeJS.Signals, () => void][] = [];
  for (const sig of ["SIGINT", "SIGBREAK", "SIGTERM"] as const) {
    const h = () => void stop(sig);
    try {
      process.on(sig, h);
      installed.push([sig, h]);
    } catch {
      // signal not supported on this platform
    }
  }
  return () => {
    for (const [sig, h] of installed) process.off(sig, h);
  };
}
