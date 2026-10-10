// OpenAI text-to-speech rendered to 48 kHz mono signed 16-bit PCM (spec 9.5, 10.2).
//
// Pipeline: OpenAI speech API (response_format "wav", self-describing so no sample-rate guess)
// -> ffmpeg (FFMPEG_PATH or "ffmpeg" on PATH) -> raw s16le 48000 Hz mono.
// Results are cached on disk under data/tts-cache/<sha256>.pcm, keyed by model, voice,
// instructions, text, and output format, so repeated call scripts start instantly
// (spec 9.5: pre-render fake call audio at onboarding).
//
// No spectrum-ts imports. No env reads: callers pass config explicitly.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI, { APIConnectionError, InternalServerError, RateLimitError } from "openai";
import { z } from "zod";

export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 1;

export interface TtsConfig {
  apiKey: string;
  /** Optional OpenAI-compatible base URL (env OPENAI_BASE_URL). Default: the SDK default. */
  baseURL?: string;
  /** e.g. "gpt-4o-mini-tts" (env TTS_MODEL). */
  model: string;
  /** Default voice (env TTS_VOICE), e.g. "alloy". */
  voice: string;
  /** ffmpeg binary. Defaults to "ffmpeg" on PATH. */
  ffmpegPath?: string;
  /** Cache directory. Defaults to <cwd>/data/tts-cache. */
  cacheDir?: string;
  /** Per-request timeout for the OpenAI call, ms. Default 30000. */
  timeoutMs?: number;
}

export interface VoiceStyle {
  /** Overrides the default voice. */
  voice?: string;
  /** Delivery instructions (not supported by tts-1 / tts-1-hd; ignored there). */
  instructions?: string;
}

/** Anything that turns text into 48 kHz mono s16 PCM. LiveKitCallService depends on this, not on OpenAI. */
export interface SpeechRenderer {
  renderPcm(text: string, style?: VoiceStyle): Promise<Int16Array>;
}

export interface RenderResult {
  pcm: Int16Array;
  /** Cache file holding the raw s16le samples. */
  file: string;
  cached: boolean;
  durationMs: number;
}

const ttsInput = z.object({ text: z.string().trim().min(1).max(4096) });
/** Validates the OpenAI response body: a RIFF/WAVE container with some payload. */
const wavBody = z
  .instanceof(Buffer)
  .refine((b) => b.length > 44, "empty audio")
  .refine((b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WAVE", "not a WAV body");

const RETRY_DELAYS_MS = [500, 1500, 4000];
const isRetryable = (e: unknown): boolean =>
  e instanceof RateLimitError || e instanceof InternalServerError || e instanceof APIConnectionError;

export class OpenAiTts implements SpeechRenderer {
  private readonly client: OpenAI;
  private readonly cacheDir: string;
  private readonly ffmpeg: string;

  constructor(private readonly cfg: TtsConfig, client?: OpenAI) {
    // SDK retries are disabled so the retry policy below (retryable errors only, with backoff) is the only one.
    this.client = client ?? new OpenAI({ apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}), maxRetries: 0, timeout: cfg.timeoutMs ?? 30_000 });
    this.cacheDir = cfg.cacheDir ?? path.resolve("data", "tts-cache");
    this.ffmpeg = cfg.ffmpegPath || "ffmpeg";
  }

  cacheKey(text: string, style: VoiceStyle = {}): string {
    const parts = {
      model: this.cfg.model,
      voice: style.voice ?? this.cfg.voice,
      instructions: style.instructions ?? "",
      text,
      out: `s16le/${PCM_SAMPLE_RATE}/${PCM_CHANNELS}`,
    };
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  async renderPcm(text: string, style?: VoiceStyle): Promise<Int16Array> {
    return (await this.render(text, style)).pcm;
  }

  async render(text: string, style: VoiceStyle = {}): Promise<RenderResult> {
    const { text: input } = ttsInput.parse({ text });
    const file = path.join(this.cacheDir, `${this.cacheKey(input, style)}.pcm`);
    const hit = await fs.readFile(file).catch(() => null);
    if (hit && hit.length >= 2) return { pcm: toInt16(hit), file, cached: true, durationMs: durationMs(hit.length) };

    const wav = await this.fetchWav(input, style);
    const raw = await this.toPcm48k(wav);
    await fs.mkdir(this.cacheDir, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, raw);
    await fs.rename(tmp, file);
    return { pcm: toInt16(raw), file, cached: false, durationMs: durationMs(raw.length) };
  }

  private async fetchWav(input: string, style: VoiceStyle): Promise<Buffer> {
    const legacy = /^tts-1/.test(this.cfg.model);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.client.audio.speech.create({
          model: this.cfg.model,
          voice: style.voice ?? this.cfg.voice,
          input,
          response_format: "wav",
          ...(style.instructions && !legacy ? { instructions: style.instructions } : {}),
        });
        return wavBody.parse(Buffer.from(await res.arrayBuffer()));
      } catch (e) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isRetryable(e)) throw e;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** WAV bytes -> raw s16le, 48 kHz, mono. */
  toPcm48k(wav: Buffer): Promise<Buffer> {
    return runFfmpeg(this.ffmpeg, ["-f", "wav", "-i", "pipe:0", "-ac", String(PCM_CHANNELS), "-ar", String(PCM_SAMPLE_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"], wav);
  }
}

/** Raw 48 kHz mono s16le -> a playable WAV (for humans listening to spike output). */
export function pcm48kToWav(ffmpegPath: string | undefined, pcm: Buffer): Promise<Buffer> {
  return runFfmpeg(ffmpegPath || "ffmpeg", ["-f", "s16le", "-ar", String(PCM_SAMPLE_RATE), "-ac", String(PCM_CHANNELS), "-i", "pipe:0", "-f", "wav", "pipe:1"], pcm);
}

export function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((PCM_SAMPLE_RATE * PCM_CHANNELS * ms) / 1000));
}

export function concatPcm(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function pcmDurationMs(pcm: Int16Array): number {
  return Math.round((pcm.length / (PCM_SAMPLE_RATE * PCM_CHANNELS)) * 1000);
}

function durationMs(bytes: number): number {
  return Math.round((bytes / 2 / (PCM_SAMPLE_RATE * PCM_CHANNELS)) * 1000);
}

function toInt16(buf: Buffer): Int16Array {
  // Copy into a fresh, aligned ArrayBuffer; drop a trailing odd byte if any. Host is little-endian (x64/arm64).
  const even = buf.length - (buf.length % 2);
  const ab = new ArrayBuffer(even);
  new Uint8Array(ab).set(buf.subarray(0, even));
  return new Int16Array(ab);
}

function runFfmpeg(bin: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`ffmpeg failed to start (${bin}): ${e.message}`)));
    p.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 500)}`));
    });
    p.stdin.on("error", () => {}); // EPIPE if ffmpeg dies early; reported via close
    p.stdin.end(input);
  });
}
