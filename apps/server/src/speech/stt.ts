// Speech to text for inbound voice notes (spec 8.4 step 6, 9.5; PHOTON_NOTES section F).
//
// transcribe(bytes, mime) converts the voice note with ffmpeg when OpenAI cannot take the container
// as is (iMessage voice notes arrive as audio/x-caf), then calls
// client.audio.transcriptions.create({ file, model }). The whole call has a 15 s budget and throws
// SttError on any failure, including an empty transcript; the caller replies
// "Couldn't hear that one, can you text it?" (spec 8.4) and, in CHECKING, treats it as AMBIGUOUS.
//
// Config comes from process.env unless overridden: OPENAI_API_KEY, STT_MODEL, FFMPEG_PATH.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { z } from "zod";

export const STT_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL = "gpt-4o-mini-transcribe";

export type SttStage = "config" | "convert" | "transcribe" | "timeout" | "empty";

export class SttError extends Error {
  readonly stage: SttStage;
  constructor(stage: SttStage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SttError";
    this.stage = stage;
  }
}

/** Minimal surface of the OpenAI client this module uses (lets tests inject a fake). */
export interface TranscriptionClient {
  audio: {
    transcriptions: {
      create(
        body: { file: Awaited<ReturnType<typeof toFile>>; model: string },
        options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
      ): PromiseLike<unknown>;
    };
  };
}

export interface SttOptions {
  apiKey?: string;
  model?: string;
  ffmpegPath?: string;
  timeoutMs?: number;
  client?: TranscriptionClient;
}

export interface SttResult {
  text: string;
  /** Container actually sent to OpenAI ("wav" after conversion, else the original extension). */
  sentAs: string;
  converted: boolean;
  convertMs: number;
  transcribeMs: number;
}

// Containers OpenAI transcription accepts directly (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm).
// CAF is not among them, so iMessage voice notes always go through ffmpeg.
const DIRECT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

const transcriptionSchema = z.object({ text: z.string() });

const clients = new Map<string, OpenAI>();
function defaultClient(apiKey: string): TranscriptionClient {
  let c = clients.get(apiKey);
  if (!c) {
    c = new OpenAI({ apiKey, maxRetries: 1 });
    clients.set(apiKey, c);
  }
  return c as unknown as TranscriptionClient;
}

function normalizeMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Run ffmpeg on a temp file and return 16 kHz mono 16-bit WAV bytes. Killed when `signal` aborts. */
export async function convertToWav(bytes: Buffer, mime: string, ffmpegPath: string, signal: AbortSignal): Promise<Buffer> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "batman-stt-"));
  const ext = normalizeMime(mime).includes("caf") ? ".caf" : ".bin";
  const input = path.join(dir, `in-${randomUUID()}${ext}`);
  const output = path.join(dir, "out.wav");
  try {
    await fsp.writeFile(input, bytes);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        ffmpegPath,
        ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => {
        if (stderr.length < 2000) stderr += d.toString("utf8");
      });
      const onAbort = () => proc.kill("SIGKILL");
      signal.addEventListener("abort", onAbort, { once: true });
      proc.on("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(new SttError("convert", `ffmpeg failed to start (${ffmpegPath}): ${err.message}`, { cause: err }));
      });
      proc.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(new SttError("timeout", "ffmpeg conversion timed out"));
        else if (code === 0) resolve();
        else reject(new SttError("convert", `ffmpeg exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
      });
    });
    const wav = await fsp.readFile(output);
    if (wav.length <= 44) throw new SttError("convert", "ffmpeg produced no audio");
    return wav;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Transcribe and return details (latencies, container). Throws SttError on any failure. */
export async function transcribeDetailed(bytes: Buffer, mime: string, opts: SttOptions = {}): Promise<SttResult> {
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!opts.client && !apiKey) throw new SttError("config", "OPENAI_API_KEY is not set; voice is disabled");
  if (bytes.length === 0) throw new SttError("convert", "voice note is empty");
  const model = opts.model || process.env.STT_MODEL || DEFAULT_MODEL;
  const ffmpegPath = opts.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  const timeoutMs = opts.timeoutMs ?? STT_TIMEOUT_MS;
  const client = opts.client ?? defaultClient(apiKey!);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const t0 = Date.now();
    const direct = DIRECT[normalizeMime(mime)];
    const audio = direct ? bytes : await convertToWav(bytes, mime, ffmpegPath, ac.signal);
    const sentAs = direct ?? "wav";
    const t1 = Date.now();
    const file = await toFile(audio, `note.${sentAs}`, { type: direct ? normalizeMime(mime) : "audio/wav" });
    let raw: unknown;
    try {
      raw = await client.audio.transcriptions.create(
        { file, model },
        { signal: ac.signal, timeout: Math.max(1000, timeoutMs - (t1 - t0)) },
      );
    } catch (err) {
      if (ac.signal.aborted) throw new SttError("timeout", `transcription timed out after ${timeoutMs} ms`, { cause: err });
      throw new SttError("transcribe", `transcription failed: ${(err as Error).message}`, { cause: err });
    }
    const parsed = transcriptionSchema.safeParse(raw);
    if (!parsed.success) throw new SttError("transcribe", "unexpected transcription response shape");
    const text = parsed.data.text.trim();
    if (!text) throw new SttError("empty", "transcript is empty");
    return { text, sentAs, converted: !direct, convertMs: t1 - t0, transcribeMs: Date.now() - t1 };
  } catch (err) {
    if (err instanceof SttError) throw err;
    if (ac.signal.aborted) throw new SttError("timeout", `speech to text timed out after ${timeoutMs} ms`, { cause: err });
    throw new SttError("transcribe", (err as Error).message, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/** transcribe(bytes, mime) => text. Converts with ffmpeg when needed; 15 s budget; throws SttError. */
export async function transcribe(bytes: Buffer, mime: string, opts?: SttOptions): Promise<string> {
  return (await transcribeDetailed(bytes, mime, opts)).text;
}
