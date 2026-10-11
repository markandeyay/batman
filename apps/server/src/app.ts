// Application assembly (spec 8.1, 8.2). createApp(env, deps) wires env, logger, store
// (migrations plus the single-instance lock), scheduler, PlanRuntime, CallService, the
// LocationSource factory, Channel, executor and the test control port. index.ts (not here)
// calls start() and plugs the dialogue manager in with onInbound(handler).
import path from "node:path";
import { LiveKitCallService } from "./calls/livekit.js";
import { TextFallbackCallService } from "./calls/textFallback.js";
import { capabilities, findRepoRoot, type Capabilities, type Env } from "./config/env.js";
import type { CallService, Clock, E164, LocationSource, TemplateId } from "./contracts.js";
import { GatewayChannel, type FocusApi, type SpaceHandle, type SpaceResolver } from "./gateway/channel.js";
import { describeError, last4 } from "./gateway/errors.js";
import { GatewayExecutor, maskForStorage, type Render } from "./gateway/executor.js";
import { createImessageClient, type ImessageClient } from "./gateway/imessageAdvanced.js";
import type { NormalizedInbound } from "./gateway/normalize.js";
import { InboundLoop, imessageResolver, installSignalHandlers, startSpectrum, toSpaceHandle, type InboundHandler, type LoopMessage, type SpectrumApp } from "./gateway/spectrum.js";
import { TERMINAL_COMMANDS, TerminalBridge, TerminalCallService } from "./gateway/terminal.js";
import { FindMyLocationSource, probeShare, type LocationsApi } from "./location/findmy.js";
import { loadTrack, ReplayLocationSource } from "./location/replay.js";
import { NoneLocationSource } from "./location/source.js";
import { renderTemplate } from "./notify/templates.js";
import { PlanRuntime } from "./plan/runtime.js";
import type { EnginePlan } from "./plan/types.js";
import { JobScheduler } from "./scheduler/jobs.js";
import { transcribe } from "./speech/stt.js";
import { OpenAiTts, PCM_SAMPLE_RATE, type SpeechRenderer } from "./speech/tts.js";
import { acquireLock, openStore, releaseLock, startLockHeartbeat, type Store } from "./store/db.js";
import * as repo from "./store/repo.js";
import { createControlPort, type ControlPort } from "./testing/controlPort.js";
import { clockFromTimeScale, ScaledClock } from "./util/clock.js";
import { createLogger, type Logger } from "./util/log.js";

export interface AppDeps {
  logger?: Logger;
  clock?: Clock;
  store?: Store;
  /** Template renderer. Default notify/templates.ts renderTemplate. */
  render?: Render;
  /** Replaces startSpectrum (tests pass a fake app; no network). */
  spectrumFactory?: () => Promise<SpectrumApp>;
  /** Replaces the advanced-imessage client (tests). null disables it. */
  imessageClientFactory?: (() => Promise<Pick<ImessageClient, "im" | "close">>) | null;
  callService?: CallService;
  /** Overrides the per-plan LocationSource. */
  locationSourceFactory?: (plan: EnginePlan, userAddress: E164, hooks: { onShareEnded: () => void }) => LocationSource;
  /** Space resolver override for iMessage (tests). */
  resolver?: SpaceResolver;
  /** I14 stop flag. Default: storeStopList(store) plus guardian.stoppedAt. */
  isStopped?: (address: E164) => Promise<boolean> | boolean;
  /** Include the iMessage provider. Default true. */
  imessage?: boolean;
  /** Retry sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Lock holder id. Default pid plus random. */
  holder?: string;
  /** Install SIGINT/SIGBREAK/SIGTERM handlers on start. Default true. */
  signals?: boolean;
}

export interface App {
  env: Env;
  caps: Capabilities;
  logger: Logger;
  clock: Clock;
  store: Store;
  channel: GatewayChannel;
  executor: GatewayExecutor;
  runtime: PlanRuntime;
  scheduler: JobScheduler;
  terminal: TerminalBridge | null;
  controlPort: ControlPort | null;
  inbound: InboundLoop | null;
  /** Plug in the dialogue manager. Replaces the default (log-only) handler. */
  onInbound(handler: InboundHandler): void;
  /** Dialogue ports with the same stop, quota and retry checks as engine sends. */
  sendTemplate(to: E164, template: TemplateId, params?: Record<string, unknown>): ReturnType<GatewayExecutor["sendTemplateTo"]>;
  sendText(to: E164, text: string): ReturnType<GatewayExecutor["sendTextTo"]>;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
}

/**
 * Address-level stop flags (I14) kept in the counters table (day "stopped", key = address),
 * because the store has no dedicated table yet (proposed: stopped_addresses).
 */
export function storeStopList(store: Store): { isStopped(a: E164): boolean; setStopped(a: E164, stopped: boolean): void } {
  return {
    isStopped: (a) => repo.getCounter(store, "stopped", a) > 0,
    setStopped: (a, stopped) => {
      if (stopped) {
        if (repo.getCounter(store, "stopped", a) === 0) repo.incrementCounter(store, "stopped", a);
      } else store.sqlite.prepare("DELETE FROM counters WHERE day = 'stopped' AND key = ?").run(a);
    },
  };
}

/** Speech off: calls play a short neutral tone so the phone still rings (DECISIONS.md). */
export class ToneRenderer implements SpeechRenderer {
  async renderPcm(): Promise<Int16Array> {
    const n = PCM_SAMPLE_RATE; // 1 s at 440 Hz, quiet
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / PCM_SAMPLE_RATE) * 4000);
    return out;
  }
}

class CompositeResolver implements SpaceResolver {
  constructor(
    private readonly terminal: TerminalBridge | null,
    private readonly imessage: () => SpaceResolver | null,
  ) {}
  async resolve(to: E164): Promise<SpaceHandle> {
    if (this.terminal?.handles(to)) return this.terminal.resolve(to);
    const im = this.imessage();
    if (!im) throw new Error(`no provider can reach ${last4(to)}`);
    return im.resolve(to);
  }
}

export function createApp(env: Env, deps: AppDeps = {}): App {
  const caps = capabilities(env);
  const root = findRepoRoot();
  const logger = deps.logger ?? createLogger({ level: env.LOG_LEVEL, logDir: path.join(root, "logs") });
  const clock = deps.clock ?? clockFromTimeScale(env.TIME_SCALE);
  const store = deps.store ?? openStore(env.DATABASE_PATH);
  const render: Render = deps.render ?? ((id, params) => renderTemplate(id, params));
  const holder = deps.holder ?? `batman-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const useImessage = deps.imessage !== false;

  // Console identities use fictional 555-01XX numbers, never a real phone.
  const terminal = env.ENABLE_TERMINAL ? new TerminalBridge() : null;

  let spectrum: SpectrumApp | null = null;
  let advanced: Pick<ImessageClient, "im" | "close"> | null = null;
  const imResolver = (): SpaceResolver | null => deps.resolver ?? (spectrum && useImessage ? imessageResolver(spectrum) : null);

  const stopList = storeStopList(store);
  const isStopped =
    deps.isStopped ??
    ((a: E164) => {
      if (stopList.isStopped(a)) return true;
      const g = repo.getGuardianByAddress(store, a);
      return !!g?.stoppedAt;
    });

  const maskBody = (to: E164, text: string): string => {
    const u = repo.getUserByAddress(store, to);
    const cw = u ? repo.getCodeWords(store, u.id) : null;
    return maskForStorage(text, cw ? [cw.exit, cw.alert] : []);
  };

  const channel = new GatewayChannel({
    store,
    clock,
    resolver: new CompositeResolver(terminal, imResolver),
    isStopped,
    focus: null,
    logger,
    maskBody,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  let calls: CallService;
  if (deps.callService) calls = deps.callService;
  else if (terminal) calls = new TerminalCallService(terminal);
  else if (caps.calls) {
    const tts: SpeechRenderer = caps.speech
      ? new OpenAiTts({
          apiKey: env.OPENAI_API_KEY!,
          model: env.TTS_MODEL!,
          voice: env.TTS_VOICE!,
          ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
          ...(env.FFMPEG_PATH ? { ffmpegPath: env.FFMPEG_PATH } : {}),
        })
      : new ToneRenderer();
    calls = new LiveKitCallService({
      url: env.LIVEKIT_URL!,
      apiKey: env.LIVEKIT_API_KEY!,
      apiSecret: env.LIVEKIT_API_SECRET!,
      trunkId: env.LIVEKIT_SIP_TRUNK_ID!,
      tts,
      logger,
      fromNumber: env.BATMAN_LINE_E164,
    });
  } else calls = new TextFallbackCallService();

  const locationsApi = (): LocationsApi | null => (advanced ? (advanced.im.locations as unknown as LocationsApi) : null);

  const defaultTrack = (): string => env.REPLAY_TRACK ?? path.join(root, "tests", "fixtures", "tracks", "date-normal.json");
  const createLocationSource =
    deps.locationSourceFactory ??
    ((plan: EnginePlan, userAddress: E164, hooks: { onShareEnded: () => void }): LocationSource => {
      switch (env.LOCATION_SOURCE) {
        case "findmy": {
          const api = locationsApi();
          if (!api) return new NoneLocationSource();
          return new FindMyLocationSource({ api, clock, logger, onShareEnded: hooks.onShareEnded });
        }
        case "replay":
          return new ReplayLocationSource(loadTrack(defaultTrack()), { clock, startAt: plan.startAt ?? clock.now(), userAddress });
        default:
          return new NoneLocationSource();
      }
    });

  const executor = new GatewayExecutor({
    store,
    clock,
    channel,
    calls,
    speech: caps.speech,
    render,
    locations: null,
    createLocationSource,
    logger,
  });

  // eslint-disable-next-line prefer-const
  let runtime: PlanRuntime;
  const scheduler = new JobScheduler(store, (job) => runtime.handleJob(job), {
    clock,
    timeScale: env.TIME_SCALE,
    onError: (job, err) => logger.warn({ jobId: job.id, kind: job.kind, error: describeError(err) }, "job failed"),
  });
  runtime = new PlanRuntime({
    store,
    clock,
    jobs: scheduler,
    out: executor,
    defaultTz: env.DEFAULT_TZ,
    shareProbe: async (plan) => {
      const api = locationsApi();
      const user = repo.getUser(store, plan.userId);
      if (!api || !user) return { visible: false, expiresAt: null };
      return probeShare(api, user.addressE164);
    },
    onError: (err, info) => logger.warn({ ...info, error: describeError(err) }, "plan runtime error"),
    onCritical: (event, info) => logger.error({ critical: true, event, ...info }, "CRITICAL plan event"),
  });
  executor.bind({ ingestFix: (id, fix) => runtime.ingestFix(id, fix), dispatch: (id, e) => runtime.dispatch(id, e) });

  let handler: InboundHandler = async (m: NormalizedInbound) => {
    logger.info({ id: m.message.id, from: last4(m.message.from), kind: m.message.content.kind, flags: m.flags }, "inbound (no dialogue handler attached)");
  };

  const controlPort = createControlPort(env, {
    store,
    fastForward: async (minutes) => {
      if (clock instanceof ScaledClock) clock.fastForward(minutes * 60_000);
      else if (typeof (clock as { advance?: unknown }).advance === "function") await (clock as unknown as { advance(ms: number): Promise<void> }).advance(minutes * 60_000);
      else throw new Error("clock cannot fast-forward (set TIME_SCALE)");
      await scheduler.runDue();
    },
    replay: async (user, track) => {
      const address = user ?? terminal?.userAddress ?? env.HUMAN_IPHONE_E164 ?? null;
      if (!address) throw new Error("no user");
      const u = repo.getUserByAddress(store, address as E164);
      const plan = u ? repo.getOpenPlanForUser(store, u.id) : null;
      if (!plan) throw new Error("user has no open plan");
      const file = path.join(root, "tests", "fixtures", "tracks", `${track}.json`);
      await executor.replaceSource(plan, new ReplayLocationSource(loadTrack(file), { clock, startAt: plan.startAt ?? clock.now(), userAddress: address as E164 }));
    },
  });

  let inbound: InboundLoop | null = null;
  let stopLock: (() => void) | null = null;
  let uninstallSignals: (() => void) | null = null;
  let started = false;
  let stopping: Promise<void> | null = null;

  const app: App = {
    env,
    caps,
    logger,
    clock,
    store,
    channel,
    executor,
    runtime,
    scheduler,
    terminal,
    controlPort,
    get inbound() {
      return inbound;
    },
    onInbound(h) {
      handler = h;
    },
    sendTemplate: (to, template, params) => executor.sendTemplateTo(to, template, params),
    sendText: (to, text) => executor.sendTextTo(to, text),

    async start() {
      if (started) return;
      started = true;
      acquireLock(store.sqlite, holder, new Date());
      stopLock = startLockHeartbeat(store.sqlite, holder, () => {
        logger.error({}, "instance lock lost to another process; stopping");
        void app.stop("lock lost");
      });
      if (deps.signals !== false) uninstallSignals = installSignalHandlers((sig) => app.stop(sig));

      if (useImessage && deps.imessageClientFactory !== null) {
        try {
          advanced = deps.imessageClientFactory
            ? await deps.imessageClientFactory()
            : await createImessageClient({ projectId: env.SPECTRUM_PROJECT_ID, projectSecret: env.SPECTRUM_PROJECT_SECRET, sharedAddress: env.IMESSAGE_GRPC_ADDRESS });
          channel.setFocus(advanced.im as unknown as FocusApi);
          executor.setLocations(advanced.im.locations);
        } catch (err) {
          logger.warn({ error: describeError(err) }, "advanced-imessage unavailable; Find My and Notify Anyway disabled");
        }
      }

      spectrum = deps.spectrumFactory
        ? await deps.spectrumFactory()
        : await startSpectrum({
            projectId: env.SPECTRUM_PROJECT_ID,
            projectSecret: env.SPECTRUM_PROJECT_SECRET,
            logLevel: env.LOG_LEVEL,
            imessage: useImessage,
            terminal: env.ENABLE_TERMINAL,
            terminalCommands: TERMINAL_COMMANDS,
          });

      inbound = new InboundLoop({
        messages: spectrum.messages,
        store,
        clock,
        normalize: {
          speech: caps.speech,
          transcribe: (bytes, mime) =>
            transcribe(bytes, mime, {
              ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
              ...(env.STT_MODEL ? { model: env.STT_MODEL } : {}),
              ...(env.FFMPEG_PATH ? { ffmpegPath: env.FFMPEG_PATH } : {}),
            }),
          onVoiceError: (err) => logger.warn({ error: describeError(err) }, "voice note transcription failed"),
        },
        resolveFrom: (m) => (m.platform === "terminal" ? (terminal?.resolveFrom(m) ?? null) : defaultFrom(m)),
        ...(terminal ? { intercept: (m: Parameters<TerminalBridge["intercept"]>[0], space: unknown) => terminal.intercept(m, space) } : {}),
        onAccepted: (from, space, m: LoopMessage) => {
          channel.rememberInbound(m.id, m, m.parentId);
          if (m.platform !== "terminal" && space && typeof (space as { send?: unknown }).send === "function" && (space as { id?: unknown }).id) {
            // Reuse the inbound space for replies (no space.create round trip).
            channel.rememberSpace(from, toSpaceHandle(space as never, "imessage"));
          }
        },
        handler: () => handler,
        logger,
      });
      void inbound.start();

      await scheduler.start();
      if (controlPort) {
        const a = await controlPort.listen();
        logger.info({ host: a.host, port: a.port }, "test control port listening (loopback only)");
      }
      logger.info({ caps, locationSource: env.LOCATION_SOURCE, terminal: !!terminal }, "Batman started");
    },

    stop(reason = "stop") {
      if (stopping) return stopping;
      stopping = (async () => {
        logger.info({ reason }, "stopping");
        uninstallSignals?.();
        inbound?.stop();
        try {
          await spectrum?.stop();
        } catch (err) {
          logger.warn({ error: describeError(err) }, "spectrum stop failed");
        }
        await scheduler.stop().catch(() => {});
        await executor.stopAll().catch(() => {});
        await controlPort?.close().catch(() => {});
        await advanced?.close().catch(() => {});
        stopLock?.();
        if (started) {
          try {
            releaseLock(store.sqlite, holder);
          } catch {
            // store may be closed already
          }
        }
        if (!deps.store) store.close();
      })();
      return stopping;
    },
  };
  return app;
}

const E164_RE = /^\+[1-9]\d{6,14}$/;
function defaultFrom(m: { sender?: { id: string; address?: string | undefined } | undefined }): E164 | null {
  const a = m.sender?.address ?? m.sender?.id;
  return typeof a === "string" && E164_RE.test(a) ? (a as E164) : null;
}
