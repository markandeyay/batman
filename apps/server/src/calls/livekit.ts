// LiveKitCallService: outbound calls through LiveKit Cloud SIP to Photon Spectrum Voice (spec 10.1, 10.2).
//
// One call = one LiveKit room:
//   1. render the script to 48 kHz mono PCM (cached TTS),
//   2. create the room, connect a bot participant (@livekit/rtc-node) and publish an audio track,
//   3. SipClient.createSipParticipant(trunk, to, room, { waitUntilAnswered }) rings the phone,
//   4. when answered, play the script (`plays` times), then delete the room (hangs up the SIP leg).
// place() resolves true only if the call was answered and the audio played. On any failure
// (TTS, LiveKit API, SIP status such as 403 caller ID rejected, 486 busy, 480/408 no answer)
// it logs and resolves false so the caller falls back to text (spec 10.4). It never throws.
// createSipParticipant is never retried: a retry could ring the phone twice.
//
// The native @livekit/rtc-node module is loaded lazily on the first call, so a text-only
// deployment never loads it. No spectrum-ts imports.
import { randomUUID } from "node:crypto";
import type { AudioSource as AudioSourceT, Room as RoomT } from "@livekit/rtc-node";
import { AccessToken, RoomServiceClient, ServerError, SipCallError, SipClient } from "livekit-server-sdk";
import { z } from "zod";
import type { CallService, DecoyCaller, E164 } from "../contracts.js";
import { PCM_CHANNELS, PCM_SAMPLE_RATE, pcmDurationMs, type SpeechRenderer } from "../speech/tts.js";
import { callScript, renderScript, type CallScriptId } from "./scripts.js";

export interface CallLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface LiveKitCallConfig {
  /** wss://<project>.livekit.cloud (env LIVEKIT_URL). */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Batman's outbound trunk to sip.spectrum.photon.codes (env LIVEKIT_SIP_TRUNK_ID). */
  trunkId: string;
  tts: SpeechRenderer;
  logger?: CallLogger;
  /** Seconds to ring before giving up. Default 30 (LiveKit upper limit 80). */
  ringingTimeoutSec?: number;
  /** SIP From. Default: the trunk's number (BATMAN_LINE_E164). */
  fromNumber?: string;
}

export const BOT_IDENTITY = "batman-bot";
export const CALLEE_IDENTITY = "callee";
const FRAME_MS = 20;

/** Zod shape of the SIPParticipantInfo fields we rely on. */
export const sipParticipantInfo = z.object({
  participantId: z.string().min(1),
  participantIdentity: z.string(),
  roomName: z.string(),
  sipCallId: z.string(),
});

/** Redacts phone numbers to the last 4 digits and drops API-key fragments (OpenAI echoes masked keys in 401s). */
export const redactPhone = (s: string): string =>
  s
    .replace(/\bsk-[A-Za-z0-9_*-]+/g, "sk-[redacted]")
    .replace(/\+\d{7,15}|(?<![\d.])\d{7,15}(?![\d.])/g, (m) => `***${m.slice(-4)}`);

/** LIVEKIT_URL (wss://...) to the https host the server SDK expects. */
export const toHttpHost = (url: string): string => url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");

/** Server API clients for LIVEKIT_URL. */
export function livekitClients(cfg: Pick<LiveKitCallConfig, "url" | "apiKey" | "apiSecret">): { rooms: RoomServiceClient; sip: SipClient } {
  const host = toHttpHost(cfg.url);
  return { rooms: new RoomServiceClient(host, cfg.apiKey, cfg.apiSecret), sip: new SipClient(host, cfg.apiKey, cfg.apiSecret) };
}

/** Structured, redacted description of a LiveKit or SIP failure. */
export function describeCallError(e: unknown): Record<string, unknown> {
  if (e instanceof SipCallError) {
    return {
      kind: "SipCallError",
      sipStatusCode: e.sipStatusCode,
      sipStatus: e.sipStatus,
      httpStatus: e.status,
      code: e.code,
      message: redactPhone(e.message),
      metadata: e.metadata ? JSON.parse(redactPhone(JSON.stringify(e.metadata))) : undefined,
      hint: e.sipStatusCode === 403 ? "403 from Photon: caller ID (From) is not a line owned by the project, or auth rejected" : undefined,
    };
  }
  if (e instanceof ServerError) {
    return { kind: "ServerError", httpStatus: e.status, code: e.code, message: redactPhone(e.message), metadata: e.metadata };
  }
  if (e instanceof Error) return { kind: e.name, message: redactPhone(e.message) };
  return { kind: "unknown", message: redactPhone(String(e)) };
}

type Rtc = typeof import("@livekit/rtc-node");
let rtcPromise: Promise<Rtc> | undefined;
export const loadRtc = (): Promise<Rtc> => (rtcPromise ??= import("@livekit/rtc-node"));

export interface Bot {
  room: RoomT;
  source: AudioSourceT;
  /** Aborted when the callee leaves the room (hung up). */
  hangup: AbortSignal;
}

/** Connects the audio bot to `roomName` and publishes a 48 kHz mono microphone track. */
export async function connectBot(cfg: Pick<LiveKitCallConfig, "url" | "apiKey" | "apiSecret">, roomName: string): Promise<Bot> {
  const rtc = await loadRtc();
  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity: BOT_IDENTITY, name: "Batman audio", ttl: "10m" });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: false, canPublishData: false });
  const room = new rtc.Room();
  const ac = new AbortController();
  room.on(rtc.RoomEvent.ParticipantDisconnected, (p) => {
    if (p.identity === CALLEE_IDENTITY) ac.abort();
  });
  room.on(rtc.RoomEvent.Disconnected, () => ac.abort());
  await room.connect(cfg.url, await at.toJwt(), { autoSubscribe: false, dynacast: false });
  const source = new rtc.AudioSource(PCM_SAMPLE_RATE, PCM_CHANNELS);
  const track = rtc.LocalAudioTrack.createAudioTrack("batman-voice", source);
  const lp = room.localParticipant;
  if (!lp) throw new Error("rtc-node: no localParticipant after connect");
  await lp.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
  return { room, source, hangup: ac.signal };
}

/** Streams PCM into the source in 20 ms frames. Returns false if aborted (callee hung up). */
export async function playPcm(source: AudioSourceT, pcm: Int16Array, signal?: AbortSignal): Promise<boolean> {
  const rtc = await loadRtc();
  const step = (PCM_SAMPLE_RATE * PCM_CHANNELS * FRAME_MS) / 1000;
  for (let i = 0; i < pcm.length; i += step) {
    if (signal?.aborted) {
      source.clearQueue();
      return false;
    }
    const chunk = pcm.slice(i, i + step); // copy: the FFI reads the frame's own buffer
    await source.captureFrame(new rtc.AudioFrame(chunk, PCM_SAMPLE_RATE, PCM_CHANNELS, chunk.length / PCM_CHANNELS));
  }
  await source.waitForPlayout();
  return !signal?.aborted;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

export class LiveKitCallService implements CallService {
  private readonly rooms: RoomServiceClient;
  private readonly sip: SipClient;
  private readonly log: CallLogger;

  constructor(private readonly cfg: LiveKitCallConfig) {
    ({ rooms: this.rooms, sip: this.sip } = livekitClients(cfg));
    this.log = cfg.logger ?? { info: () => {}, warn: () => {} };
  }

  /** Pre-renders the user's fake and check-in call audio (spec 9.5) so the exit call starts fast. */
  async prewarm(decoy: DecoyCaller): Promise<void> {
    for (const id of ["fake", "checkin"] as const) await renderScript(this.cfg.tts, callScript(id, { decoy, userName: "" }));
  }

  async place(to: E164, script: CallScriptId, ctx: { decoy: DecoyCaller; userName: string }): Promise<boolean> {
    const roomName = `batman-${script}-${randomUUID().slice(0, 8)}`;
    const t0 = Date.now();
    const base = { roomName, script, to: redactPhone(to) };
    let bot: Bot | undefined;
    let roomCreated = false;
    try {
      const s = callScript(script, ctx);
      const pcm = await renderScript(this.cfg.tts, s);
      const playMs = pcmDurationMs(pcm) * s.plays + s.gapMs * (s.plays - 1);
      const ringing = this.cfg.ringingTimeoutSec ?? 30;

      await this.rooms.createRoom({ name: roomName, emptyTimeout: 60, departureTimeout: 5, maxParticipants: 3 });
      roomCreated = true;
      bot = await connectBot(this.cfg, roomName);
      this.log.info({ ...base, ms: Date.now() - t0 }, "call: bot published, dialing");

      const info = sipParticipantInfo.parse(
        await this.sip.createSipParticipant(this.cfg.trunkId, to, roomName, {
          participantIdentity: CALLEE_IDENTITY,
          participantName: "callee",
          waitUntilAnswered: true,
          ringingTimeout: ringing,
          maxCallDuration: Math.max(30, Math.ceil(playMs / 1000) + 15),
          timeout: ringing + 20,
          ...(this.cfg.fromNumber ? { fromNumber: this.cfg.fromNumber } : {}),
        }),
      );
      this.log.info({ ...base, sipCallId: info.sipCallId, ms: Date.now() - t0 }, "call: answered");

      await sleep(600, bot.hangup); // let the media path settle before speaking
      let completed = true;
      for (let i = 0; i < s.plays && completed; i++) {
        if (i > 0) await sleep(s.gapMs, bot.hangup);
        completed = await playPcm(bot.source, pcm, bot.hangup);
      }
      this.log.info({ ...base, completed, ms: Date.now() - t0 }, completed ? "call: script played" : "call: callee hung up early");
      return true;
    } catch (e) {
      this.log.warn({ ...base, ms: Date.now() - t0, error: describeCallError(e) }, "call: failed, caller falls back to text");
      return false;
    } finally {
      await bot?.room.disconnect().catch(() => {});
      if (roomCreated) await this.rooms.deleteRoom(roomName).catch(() => {}); // removes the SIP participant: hang up
    }
  }
}
