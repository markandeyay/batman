// Spike S3 (inbound voice note format + transcription) and S4 (iMessage "Send My Current Location"
// pin format), plus the Phase 1 echo precheck (send + react). Spec Sections 8.4, 11.2, 14 (0b).
// Human steps: docs/spikes/S3_S4.md.
//
// Run from the repo root (PowerShell or Git Bash):
//   npx tsx scripts/spike-inbound.ts 20      # listen for 20 minutes (default 20)
//   npx tsx scripts/spike-inbound.ts 60s     # 60 second smoke test
// Optional env: LOG_LEVEL (debug|info|warn|error|silent, SDK log level), SPIKE_S3_DIR (where
// voice notes and attachments are saved), FFMPEG_PATH (else ffmpeg on PATH).
//
// Rules: loads .env itself and never prints secret values; phone numbers are redacted to the last
// 4 digits in every log line; nothing is sent unless HUMAN_IPHONE_E164 texts "ping" first.
// Uses the imessage cloud provider only (never @spectrum-ts/imessage-local).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Emoji, Spectrum } from "spectrum-ts";
import type { Content, Message, PlatformProviderConfig, Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { isLocationVCardName, parsePin, parseVCardPin } from "../apps/server/src/location/pin.js";
import { SttError, transcribeDetailed } from "../apps/server/src/speech/stt.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH_DIR =
  process.env.SPIKE_S3_DIR ??
  "C:\\Users\\yalam\\AppData\\Local\\Temp\\claude\\C--Users-yalam-batman\\7e7aae10-9889-4c41-9f27-b18a551b3d5d\\scratchpad\\spike-s3";

// ---------- duration arg: "20" = minutes, "60s" = seconds ----------
function parseDuration(arg: string | undefined): number {
  if (!arg) return 20 * 60;
  const m = /^(\d+(?:\.\d+)?)(s|m)?$/i.exec(arg.trim());
  if (!m) {
    console.error(`Bad duration "${arg}". Use minutes ("20") or seconds ("60s").`);
    process.exit(2);
  }
  const n = Number(m[1]);
  return Math.max(1, Math.round(m[2]?.toLowerCase() === "s" ? n : n * 60));
}
const MAX_SECONDS = parseDuration(process.argv[2]);

// ---------- .env (same minimal parser as scripts/doctor.ts; values are never printed) ----------
function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    const hash = v.indexOf(" #");
    if (hash >= 0) v = v.slice(0, hash).trim();
    out[m[1]!] = v.replace(/^"(.*)"$/, "$1");
  }
  return out;
}
const env: Record<string, string | undefined> = { ...loadEnv(path.join(root, ".env")), ...process.env };

// ---------- redaction and logging ----------
// E.164 (+ and 7 to 15 digits), bare digit runs of 7 to 15 not touching letters/dots (keeps
// coordinates, hex dumps and ISO timestamps intact), and formatted numbers like (555) 123-4567.
const PHONE_PATTERNS: RegExp[] = [
  /\+\d{7,15}\b/g,
  /(?<![\w.:-])\d{7,15}(?![\w.])/g,
  /(?<![\w.])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.])/g,
];
export function redactPhones(s: string): string {
  let out = s;
  for (const re of PHONE_PATTERNS) out = out.replace(re, (m) => `***${m.replace(/\D/g, "").slice(-4)}`);
  return out;
}
// The SDK's own logger writes straight to stdout/stderr, so redact at the stream level too.
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) =>
    write(typeof chunk === "string" ? redactPhones(chunk) : Buffer.isBuffer(chunk) ? redactPhones(chunk.toString("utf8")) : chunk, ...rest)) as typeof stream.write;
}
const last4 = (s: string | undefined): string => (s ? `***${s.replace(/\D/g, "").slice(-4) || s.slice(-4)}` : "<none>");
const ts = (): string => new Date().toISOString();
function log(line: string, extra?: unknown): void {
  const tail = extra === undefined ? "" : " " + safeJson(extra);
  console.log(redactPhones(`[${ts()}] ${line}${tail}`));
}

// JSON dump with Buffers replaced by "<bytes N>", functions by "<fn>", and nested Message objects
// (reaction/read targets, group items) shortened.
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    function replacer(this: unknown, key: string, v: unknown) {
      if (Buffer.isBuffer(v)) return `<bytes ${v.length}>`;
      if (v instanceof Uint8Array) return `<bytes ${v.byteLength}>`;
      if (v && typeof v === "object" && (v as { type?: unknown }).type === "Buffer" && Array.isArray((v as { data?: unknown }).data))
        return `<bytes ${(v as { data: unknown[] }).data.length}>`;
      if (typeof v === "function") return "<fn>";
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Date) return v.toISOString();
      if (v && typeof v === "object") {
        if (seen.has(v)) return "<circular>";
        seen.add(v);
        if (key === "target" || key === "space") {
          const o = v as { id?: unknown; direction?: unknown; content?: { type?: unknown } };
          return { id: o.id, direction: o.direction, contentType: o.content?.type, "<trimmed>": true };
        }
      }
      return v;
    },
    0,
  );
}

const senderAddress = (m: Message): string | undefined => {
  const s = m.sender as { id?: string; address?: string } | undefined;
  return s?.address ?? s?.id;
};
const digits = (s: string | undefined): string => (s ?? "").replace(/\D/g, "");

// ---------- audio container sniffing (Spike S3) ----------
function sniffAudio(buf: Buffer): string {
  const a = buf.subarray(0, 4).toString("latin1");
  if (a === "caff") return "CAF (Apple Core Audio Format)";
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return `ISO BMFF, brand ${buf.subarray(8, 12).toString("latin1")} (M4A/MP4)`;
  if (a === "OggS") return "Ogg";
  if (a === "RIFF") return "WAV";
  if (buf[0] === 0xff && ((buf[1] ?? 0) & 0xf6) === 0xf0) return "raw AAC ADTS";
  if (buf.subarray(0, 3).toString("latin1") === "ID3" || (buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0)) return "MP3";
  return "unknown";
}
// CAF: 8-byte file header then chunks; the 'desc' chunk's format id (4cc) names the codec.
function cafCodec(buf: Buffer): string | undefined {
  if (buf.subarray(0, 4).toString("latin1") !== "caff") return undefined;
  let off = 8;
  while (off + 12 <= buf.length) {
    const type = buf.subarray(off, off + 4).toString("latin1");
    const size = Number(buf.readBigInt64BE(off + 4));
    if (type === "desc" && off + 12 + 32 <= buf.length) {
      const sampleRate = buf.readDoubleBE(off + 12);
      const fmt = buf.subarray(off + 20, off + 24).toString("latin1");
      const channels = buf.readUInt32BE(off + 12 + 24);
      return `${fmt} ${sampleRate} Hz ${channels} ch`;
    }
    if (size < 0) break;
    off += 12 + size;
  }
  return undefined;
}
function extFor(mime: string, sniff: string): string {
  if (sniff.startsWith("CAF") || mime.includes("caf")) return ".caf";
  if (sniff.startsWith("ISO BMFF") || /mp4|m4a|aac/.test(mime)) return ".m4a";
  if (sniff.startsWith("Ogg")) return ".ogg";
  if (sniff === "WAV") return ".wav";
  if (sniff === "MP3") return ".mp3";
  return ".bin";
}
const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);

// ---------- main ----------
type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const LOG_LEVELS = new Set<string>(["debug", "info", "warn", "error", "silent"]);

async function main(): Promise<void> {
  const projectId = env.SPECTRUM_PROJECT_ID;
  const projectSecret = env.SPECTRUM_PROJECT_SECRET;
  const humanE164 = env.HUMAN_IPHONE_E164;
  const missing = Object.entries({ SPECTRUM_PROJECT_ID: projectId, SPECTRUM_PROJECT_SECRET: projectSecret, HUMAN_IPHONE_E164: humanE164 })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing .env variables: ${missing.join(", ")}. Add them by name; this script never prints values.`);
    process.exit(2);
  }
  const voiceEnabled = !!env.OPENAI_API_KEY;
  const rawLevel = env.LOG_LEVEL ?? "info";
  const logLevel = (LOG_LEVELS.has(rawLevel) ? rawLevel : "info") as LogLevel;
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  log(
    `spike-inbound starting: human=${last4(humanE164)} batmanLine=${last4(env.BATMAN_LINE_E164)} voice=${voiceEnabled ? `on (${env.STT_MODEL ?? "default model"})` : "off (OPENAI_API_KEY missing)"} logLevel=${logLevel} maxSeconds=${MAX_SECONDS}`,
  );
  log(`saving voice notes and attachments to ${SCRATCH_DIR}`);

  // Typing workaround: in 12.10.1 `imessage.config(...)` resolves its parameter to `never` and its
  // return type is not assignable to PlatformProviderConfig (reproduced with TS 7.0.2 and 5.9.3).
  // Runtime is fine: config({}) is the documented call. See docs/spikes/S3_S4.md open questions.
  const imessageConfig = imessage.config as unknown as (cfg?: Record<string, never>) => PlatformProviderConfig;
  const t0 = Date.now();
  const app = await Spectrum({
    projectId: projectId!,
    projectSecret: projectSecret!,
    providers: [imessageConfig({})],
    options: { logLevel },
  });
  log(`Spectrum connected in ${Date.now() - t0} ms: project name="${app.config.name}" slug=${app.config.slug}`);

  // Shutdown plumbing (spec 11.2: Spectrum registers no signal handlers).
  let stopping = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(alive);
    log(`stopping (${reason})`);
    try {
      await app.stop();
      log("app.stop() done");
    } catch (err) {
      log(`app.stop() error: ${(err as Error).message}`);
    }
    setTimeout(() => process.exit(0), 500).unref();
  };
  for (const sig of ["SIGINT", "SIGBREAK", "SIGTERM"] as const) {
    try {
      process.on(sig, () => void stop(sig));
    } catch {
      /* signal not supported on this platform */
    }
  }
  setTimeout(() => void stop(`time limit ${MAX_SECONDS}s`), MAX_SECONDS * 1000).unref();
  const alive = setInterval(() => log("stream alive, waiting for messages"), Math.min(30_000, MAX_SECONDS * 500));
  alive.unref();

  log('listening on app.messages. iPhone steps: text "ping", a voice note, Send My Current Location, a contact card.');

  let n = 0;
  const handle = async (space: Space, message: Message, label: string): Promise<void> => {
    const content: Content = message.content;
    const sender = senderAddress(message);
    const parentId = (message as unknown as { parentId?: string }).parentId;
    const lagMs = Date.now() - new Date(message.timestamp).getTime();

    if (content.type === "read") {
      log(`${label} READ platform=${message.platform} id=${message.id} target=${content.target?.id ?? "?"} sender=${last4(sender)}`);
      return;
    }
    log(
      `${label} platform=${message.platform} id=${message.id} parentId=${parentId ?? "<none>"} space=${last4(space.id)} sender=${last4(sender)} content.type=${content.type} timestamp=${new Date(message.timestamp).toISOString()} lagMs=${lagMs}`,
    );
    log(`${label} content`, content);

    switch (content.type) {
      case "voice": {
        const tr = Date.now();
        const buf = await content.read();
        const readMs = Date.now() - tr;
        const sniff = sniffAudio(buf);
        const file = path.join(SCRATCH_DIR, `voice-${Date.now()}-${safeName(message.id)}${extFor(content.mimeType, sniff)}`);
        fs.writeFileSync(file, buf);
        log(
          `${label} VOICE mimeType=${content.mimeType} name=${content.name ?? "<none>"} size=${content.size ?? "<unset>"} bytes=${buf.length} duration=${content.duration ?? "<unset>"} readMs=${readMs} first12=${buf.subarray(0, 12).toString("hex")} sniff="${sniff}" cafDesc="${cafCodec(buf) ?? "n/a"}" saved=${file}`,
        );
        if (!voiceEnabled) {
          log(`${label} STT skipped: OPENAI_API_KEY missing`);
          break;
        }
        const ts0 = Date.now();
        try {
          const r = await transcribeDetailed(buf, content.mimeType, {
            apiKey: env.OPENAI_API_KEY!,
            ...(env.STT_MODEL ? { model: env.STT_MODEL } : {}),
            ...(env.FFMPEG_PATH ? { ffmpegPath: env.FFMPEG_PATH } : {}),
          });
          log(
            `${label} STT OK transcript="${r.text}" sentAs=${r.sentAs} converted=${r.converted} convertMs=${r.convertMs} transcribeMs=${r.transcribeMs} totalMs=${Date.now() - ts0} endToEndFromSendMs=${Date.now() - new Date(message.timestamp).getTime()}`,
          );
        } catch (err) {
          const stage = err instanceof SttError ? err.stage : "unknown";
          log(`${label} STT FAIL stage=${stage} after ${Date.now() - ts0} ms: ${(err as Error).message}`);
        }
        break;
      }
      case "contact": {
        const rawVcf = typeof content.raw === "string" ? content.raw : undefined;
        const card = rawVcf ? parseVCardPin(rawVcf) : undefined;
        const pin = parsePin({ urls: content.urls, vcf: rawVcf });
        log(
          `${label} CONTACT name=${safeJson(content.name)} phones=${safeJson(content.phones)} emails=${safeJson(content.emails)} urls=${safeJson(content.urls ?? [])} vcardUrls=${safeJson(card?.urls ?? [])} org=${safeJson(content.org)} hasPhoto=${!!content.photo} rawType=${typeof content.raw} isLocationCard=${card?.isLocationCard ?? "n/a"}`,
        );
        if (rawVcf) log(`${label} CONTACT raw vCard (photo lines trimmed):\n${rawVcf.replace(/^(PHOTO[^\r\n]*)(\r?\n[ \t][^\r\n]*)*/gim, "PHOTO<trimmed>")}`);
        log(pin ? `${label} S4 PARSED lat=${pin.lat} lng=${pin.lng} source=${pin.source} field=${pin.field}` : `${label} S4 no coordinates in contact urls, URL lines, or GEO`);
        break;
      }
      case "attachment": {
        const buf = await content.read();
        const isText = /^(text\/|application\/(x-)?vcard)/i.test(content.mimeType) || /\.vcf$/i.test(content.name);
        const file = path.join(SCRATCH_DIR, `attachment-${Date.now()}-${safeName(content.name)}`);
        fs.writeFileSync(file, buf);
        log(
          `${label} ATTACHMENT id=${content.id} name=${content.name} mimeType=${content.mimeType} size=${content.size ?? "<unset>"} bytes=${buf.length} first12=${buf.subarray(0, 12).toString("hex")} isLocVcfName=${isLocationVCardName(content.name)} saved=${file}`,
        );
        if (isText) {
          const txt = buf.toString("utf8");
          log(`${label} ATTACHMENT text body:\n${txt.slice(0, 4000)}`);
          const card = parseVCardPin(txt);
          const pin = parsePin({ vcf: txt, text: txt });
          log(pin ? `${label} S4 PARSED lat=${pin.lat} lng=${pin.lng} source=${pin.source} field=${pin.field} urls=${safeJson(card.urls)}` : `${label} S4 no coordinates in attachment; urls=${safeJson(card.urls)}`);
        }
        break;
      }
      case "text": {
        const pin = parsePin({ text: content.text });
        if (pin) log(`${label} S4 PARSED from text lat=${pin.lat} lng=${pin.lng} source=${pin.source} field=${pin.field}`);
        const isHuman = !!sender && digits(sender).length >= 7 && digits(sender) === digits(humanE164);
        if (isHuman && content.text.trim().toLowerCase() === "ping") {
          const s0 = Date.now();
          const sent = await space.send("pong");
          const sendMs = Date.now() - s0;
          log(`${label} ECHO sent "pong": outbound id=${sent?.id ?? "<undefined>"} direction=${sent?.direction ?? "?"} sendMs=${sendMs}`);
          const r0 = Date.now();
          const reaction = await message.react(Emoji.like);
          log(
            `${label} ECHO reacted like: reaction message id=${reaction?.id ?? "<undefined>"} reactMs=${Date.now() - r0} inboundToPongMs=${s0 + sendMs - new Date(message.timestamp).getTime()}`,
          );
        }
        break;
      }
      case "group": {
        log(`${label} GROUP with ${content.items.length} items`);
        let i = 0;
        for (const item of content.items) await handle(space, item, `${label}.${i++}`);
        break;
      }
      default:
        break;
    }
  };

  for await (const [space, message] of app.messages) {
    if (message.direction === "outbound") continue;
    n++;
    try {
      await handle(space, message, `#${n}`);
    } catch (err) {
      log(`handler error for message ${message.id}: ${(err as Error).stack ?? String(err)}`);
    }
  }
  log("app.messages stream ended");
}

main().catch((err) => {
  console.error(redactPhones(`fatal: ${(err as Error).stack ?? String(err)}`));
  process.exit(1);
});
