import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SttError, transcribe, transcribeDetailed, type TranscriptionClient } from "../../../apps/server/src/speech/stt.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ["-version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

function makeCaf(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-test-"));
  const out = path.join(dir, "tone.caf");
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "48000", "-c:a", "libopus", out], {
    windowsHide: true,
  });
  const buf = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

type Seen = { name: string; type: string; size: number; model: string };
function fakeClient(reply: unknown, seen: Seen[] = [], delayMs = 0): TranscriptionClient {
  return {
    audio: {
      transcriptions: {
        async create(body, options) {
          seen.push({ name: body.file.name, type: body.file.type, size: body.file.size, model: body.model });
          if (delayMs) {
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, delayMs);
              options?.signal?.addEventListener("abort", () => {
                clearTimeout(t);
                reject(new Error("aborted"));
              });
            });
          }
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    },
  };
}

describe("stt.transcribe", () => {
  it.skipIf(!hasFfmpeg)("converts audio/x-caf to wav with ffmpeg before transcribing", async () => {
    const seen: Seen[] = [];
    const r = await transcribeDetailed(makeCaf(), "audio/x-caf", { client: fakeClient({ text: " hello " }, seen), model: "m", ffmpegPath: FFMPEG });
    expect(r).toMatchObject({ text: "hello", sentAs: "wav", converted: true });
    expect(seen[0]).toMatchObject({ name: "note.wav", type: "audio/wav", model: "m" });
    expect(seen[0]!.size).toBeGreaterThan(44);
  });

  it("sends supported containers as is", async () => {
    const seen: Seen[] = [];
    const text = await transcribe(Buffer.from("fake m4a bytes"), "audio/mp4", { client: fakeClient({ text: "hi" }, seen) });
    expect(text).toBe("hi");
    expect(seen[0]).toMatchObject({ name: "note.m4a", type: "audio/mp4" });
  });

  it.skipIf(!hasFfmpeg)("throws SttError(convert) on bytes ffmpeg cannot decode", async () => {
    await expect(transcribe(Buffer.from("not audio"), "audio/x-caf", { client: fakeClient({ text: "x" }), ffmpegPath: FFMPEG })).rejects.toMatchObject({
      name: "SttError",
      stage: "convert",
    });
  });

  it("throws on empty transcript, bad shape, API error, and missing key", async () => {
    const m4a = Buffer.from("x");
    await expect(transcribe(m4a, "audio/mp4", { client: fakeClient({ text: "  " }) })).rejects.toMatchObject({ stage: "empty" });
    await expect(transcribe(m4a, "audio/mp4", { client: fakeClient({ nope: 1 }) })).rejects.toMatchObject({ stage: "transcribe" });
    await expect(transcribe(m4a, "audio/mp4", { client: fakeClient(new Error("401")) })).rejects.toBeInstanceOf(SttError);
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(transcribe(m4a, "audio/mp4")).rejects.toMatchObject({ stage: "config" });
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it("enforces the timeout", async () => {
    await expect(transcribe(Buffer.from("x"), "audio/mp4", { client: fakeClient({ text: "late" }, [], 2000), timeoutMs: 50 })).rejects.toMatchObject({
      stage: "timeout",
    });
  });
});
