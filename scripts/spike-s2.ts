// Spike S2 (spec Section 14, 0b; 10.1 to 10.4): outbound call from Batman's line through
// LiveKit Cloud SIP to Photon Spectrum Voice, playing a TTS clip.
//
// Run:  npx tsx scripts/spike-s2.ts <step>
//   check            list SIP outbound trunks (id, name, address, transport only), confirm
//                    LIVEKIT_SIP_TRUNK_ID is "batman-photon", verify @livekit/rtc-node loads.
//   tts              render the test clip with OpenAI TTS, ffmpeg to 48 kHz mono s16, save to
//                    the scratchpad (clip.pcm + clip.wav). No phone involved.
//   tone             no-OpenAI fallback: write a 2 s 440 Hz tone as clip.pcm with ffmpeg (proves
//                    ringing, caller ID, and audio path even if OPENAI_API_KEY is rejected).
//   room             bot-only LiveKit room: connect, publish the clip, delete. No SIP, no phone.
//   call             RINGS HUMAN_IPHONE_E164. Bot publishes, createSipParticipant waits for
//                    answer, plays the clip twice, hangs up, deletes the room. Logs SIP status.
//   service <script> RINGS HUMAN_IPHONE_E164 via LiveKitCallService.place (fake|checkin|guardian_alert).
//
// Never touches any trunk other than LIVEKIT_SIP_TRUNK_ID (the "ATP demo" trunk is read-only
// listed by `check` and otherwise ignored). Loads .env itself and never prints secrets.
// Phone numbers are redacted to the last 4 digits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  CALLEE_IDENTITY,
  LiveKitCallService,
  connectBot,
  describeCallError,
  livekitClients,
  loadRtc,
  playPcm,
  redactPhone,
  sipParticipantInfo,
} from "../apps/server/src/calls/livekit.js";
import { execFileSync } from "node:child_process";
import { OpenAiTts, pcm48kToWav, pcmDurationMs } from "../apps/server/src/speech/tts.js";

const TRUNK_NAME = "batman-photon";
const CLIP_TEXT = "Hey, it's me. Just checking you got this call. Okay, bye.";
const SESSION = "7e7aae10-9889-4c41-9f27-b18a551b3d5d";

// ---------- paths and env ----------
const root = path.resolve(import.meta.dirname, "..");
const outDir =
  process.env.SPIKE_S2_OUT ??
  path.join(os.tmpdir(), "claude", "C--Users-yalam-batman", SESSION, "scratchpad", "spike-s2");

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
const env = loadEnv(path.join(root, ".env"));
function need(k: string): string {
  const v = env[k];
  if (!v) {
    console.error(`FAIL  .env is missing ${k}. Add it by name; this script never prints values.`);
    process.exit(2);
  }
  return v;
}

const ts = () => new Date().toISOString();
const log = (msg: string, data?: unknown) =>
  console.log(`[${ts()}] ${redactPhone(msg)}${data === undefined ? "" : " " + redactPhone(JSON.stringify(data))}`);

const TRANSPORT: Record<number, string> = { 0: "AUTO", 1: "UDP", 2: "TCP", 3: "TLS" }; // @livekit/protocol SIPTransport

const lk = () => ({ url: need("LIVEKIT_URL"), apiKey: need("LIVEKIT_API_KEY"), apiSecret: need("LIVEKIT_API_SECRET") });
const tts = () =>
  new OpenAiTts({
    apiKey: need("OPENAI_API_KEY"),
    ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
    model: need("TTS_MODEL"),
    voice: need("TTS_VOICE"),
    ...(env.FFMPEG_PATH ? { ffmpegPath: env.FFMPEG_PATH } : {}),
    cacheDir: path.join(outDir, "cache"),
  });
const clipPath = path.join(outDir, "clip.pcm");

function readClip(): Int16Array {
  if (!fs.existsSync(clipPath)) {
    console.error(`FAIL  ${clipPath} missing. Run the tts step first.`);
    process.exit(2);
  }
  const b = fs.readFileSync(clipPath);
  const ab = new ArrayBuffer(b.length - (b.length % 2));
  new Uint8Array(ab).set(b.subarray(0, ab.byteLength));
  return new Int16Array(ab);
}

// ---------- steps ----------
async function check(): Promise<boolean> {
  const { sip } = livekitClients(lk());
  const trunkId = need("LIVEKIT_SIP_TRUNK_ID");
  const line = need("BATMAN_LINE_E164");
  const trunks = await sip.listSipOutboundTrunk();
  log(`outbound trunks: ${trunks.length}`);
  for (const t of trunks) {
    console.log(`  id=${t.sipTrunkId}  name=${JSON.stringify(t.name)}  address=${t.address}  transport=${TRANSPORT[t.transport] ?? t.transport}`);
  }
  let ok = true;
  const mine = trunks.find((t) => t.sipTrunkId === trunkId);
  if (!mine) {
    log(`FAIL  LIVEKIT_SIP_TRUNK_ID ${trunkId} not found in this LiveKit project`);
    ok = false;
  } else {
    const checks: [string, boolean][] = [
      [`name is ${TRUNK_NAME}`, mine.name === TRUNK_NAME],
      ["address is sip.spectrum.photon.codes:5061", mine.address === "sip.spectrum.photon.codes:5061"],
      ["transport is TLS", mine.transport === 3],
      ["numbers include BATMAN_LINE_E164", mine.numbers.includes(line)],
      ["auth username set", !!mine.authUsername],
    ];
    for (const [label, pass] of checks) {
      log(`${pass ? "PASS" : "FAIL"}  env trunk ${label}`);
      ok &&= pass;
    }
  }
  try {
    const rtc = await loadRtc();
    const names = ["Room", "AudioSource", "AudioFrame", "LocalAudioTrack", "TrackPublishOptions", "TrackSource", "dispose"] as const;
    const missing = names.filter((n) => typeof (rtc as Record<string, unknown>)[n] === "undefined");
    log(missing.length ? `FAIL  @livekit/rtc-node missing exports: ${missing.join(", ")}` : `PASS  @livekit/rtc-node loads (${Object.keys(rtc).length} exports)`);
    // Constructing an AudioSource exercises the native FFI binding.
    const src = new rtc.AudioSource(48000, 1);
    await src.close();
    log("PASS  native FFI: AudioSource(48000, 1) created and closed");
    ok &&= missing.length === 0;
  } catch (e) {
    log("FAIL  @livekit/rtc-node", describeCallError(e));
    ok = false;
  }
  return ok;
}

async function renderClip(): Promise<boolean> {
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const r = await tts().render(CLIP_TEXT);
  fs.copyFileSync(r.file, clipPath);
  const wav = await pcm48kToWav(env.FFMPEG_PATH, fs.readFileSync(clipPath));
  fs.writeFileSync(path.join(outDir, "clip.wav"), wav);
  log(`PASS  tts: ${r.pcm.length} samples, 48000 Hz mono s16, ${r.durationMs} ms audio, cached=${r.cached}, ${Date.now() - t0} ms wall`);
  log(`      saved ${clipPath} and clip.wav (model ${need("TTS_MODEL")}, voice ${need("TTS_VOICE")})`);
  return true;
}

function tone(): boolean {
  fs.mkdirSync(outDir, { recursive: true });
  const ff = env.FFMPEG_PATH || "ffmpeg";
  const raw = execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000", "-ac", "1", "-ar", "48000", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"], { maxBuffer: 16 << 20 });
  fs.writeFileSync(clipPath, raw);
  log(`PASS  tone: ${raw.length / 2} samples (2 s, 440 Hz, 48000 Hz mono s16) saved to ${clipPath}`);
  return true;
}

async function roomOnly(): Promise<boolean> {
  const cfg = lk();
  const { rooms } = livekitClients(cfg);
  const roomName = `batman-s2-room-${Date.now().toString(36)}`;
  const pcm = readClip();
  await rooms.createRoom({ name: roomName, emptyTimeout: 30, maxParticipants: 2 });
  log(`room created ${roomName}`);
  try {
    const bot = await connectBot(cfg, roomName);
    log("PASS  bot connected and published 48 kHz mono track");
    const t0 = Date.now();
    await playPcm(bot.source, pcm);
    log(`PASS  streamed ${pcmDurationMs(pcm)} ms of audio in ${Date.now() - t0} ms`);
    await bot.room.disconnect();
    return true;
  } finally {
    await rooms.deleteRoom(roomName).catch(() => {});
    log("room deleted");
  }
}

async function call(): Promise<boolean> {
  const cfg = lk();
  const trunkId = need("LIVEKIT_SIP_TRUNK_ID");
  const to = need("HUMAN_IPHONE_E164");
  log(`caller ID (trunk number) BATMAN_LINE_E164=${need("BATMAN_LINE_E164")}, callee HUMAN_IPHONE_E164=${to}`);
  const pcm = readClip();
  const rtc = await loadRtc();
  const { rooms, sip } = livekitClients(cfg);
  const roomName = `batman-s2-call-${Date.now().toString(36)}`;
  await rooms.createRoom({ name: roomName, emptyTimeout: 60, departureTimeout: 5, maxParticipants: 3 });
  log(`room created ${roomName}`);
  let bot: Awaited<ReturnType<typeof connectBot>> | undefined;
  const t0 = Date.now();
  try {
    bot = await connectBot(cfg, roomName);
    log("bot connected and published track");
    bot.room.on(rtc.RoomEvent.ParticipantConnected, (p) => log(`participant joined: ${p.identity} kind=${p.kind}`, p.attributes));
    bot.room.on(rtc.RoomEvent.ParticipantAttributesChanged, (changed, p) => log(`attributes ${p.identity}`, changed));
    bot.room.on(rtc.RoomEvent.ParticipantDisconnected, (p) => log(`participant left: ${p.identity}`, p.attributes));
    bot.room.on(rtc.RoomEvent.LocalTrackSubscribed, () => log("callee subscribed to bot audio"));

    log(`dialing via trunk ${trunkId} (ringingTimeout 30 s, maxCallDuration 60 s)`);
    let info;
    try {
      info = sipParticipantInfo.parse(
        await sip.createSipParticipant(trunkId, to, roomName, {
          participantIdentity: CALLEE_IDENTITY,
          participantName: "callee",
          waitUntilAnswered: true,
          ringingTimeout: 30,
          maxCallDuration: 60,
          timeout: 50,
        }),
      );
    } catch (e) {
      const d = describeCallError(e);
      log(`FAIL  createSipParticipant after ${Date.now() - t0} ms`, d);
      if (d.sipStatusCode === 403) log("      403 = Photon rejected the caller ID (shared-pool number not accepted as From) or auth. Branch: voice-note fallback (spec 10.4).");
      return false;
    }
    log(`PASS  answered after ${Date.now() - t0} ms`, info);
    await new Promise((r) => setTimeout(r, 600));
    for (let i = 1; i <= 2; i++) {
      const done = await playPcm(bot.source, pcm, bot.hangup);
      log(done ? `played clip ${i}/2` : `callee hung up during play ${i}`);
      if (!done) break;
      if (i === 1) await new Promise((r) => setTimeout(r, 1500));
    }
    log("hanging up");
    return true;
  } finally {
    await bot?.room.disconnect().catch(() => {});
    await rooms.deleteRoom(roomName).catch(() => {});
    log(`room deleted after ${Date.now() - t0} ms total`);
  }
}

async function service(script: string | undefined): Promise<boolean> {
  if (script !== "fake" && script !== "checkin" && script !== "guardian_alert") {
    console.error("usage: spike-s2.ts service <fake|checkin|guardian_alert>");
    process.exit(2);
  }
  const svc = new LiveKitCallService({
    ...lk(),
    trunkId: need("LIVEKIT_SIP_TRUNK_ID"),
    tts: tts(),
    logger: { info: (o, m) => log(`info ${m ?? ""}`, o), warn: (o, m) => log(`warn ${m ?? ""}`, o) },
  });
  const ok = await svc.place(need("HUMAN_IPHONE_E164"), script, { decoy: "roommate", userName: "Alex" });
  log(`${ok ? "PASS" : "FAIL"}  LiveKitCallService.place(${script}) returned ${ok}`);
  return ok;
}

// ---------- main ----------
const [step, arg] = process.argv.slice(2);
let ok = false;
try {
  switch (step) {
    case "check": ok = await check(); break;
    case "tts": ok = await renderClip(); break;
    case "tone": ok = tone(); break;
    case "room": ok = await roomOnly(); break;
    case "call": ok = await call(); break;
    case "service": ok = await service(arg); break;
    default:
      console.error("usage: npx tsx scripts/spike-s2.ts <check|tts|tone|room|call|service <script>>");
      process.exit(2);
  }
} catch (e) {
  log("FAIL  unexpected error", describeCallError(e));
} finally {
  if (["check", "room", "call", "service"].includes(step ?? "")) await (await loadRtc()).dispose().catch(() => {});
}
log(`${step}: ${ok ? "PASS" : "FAIL"}`);
// Let handles close naturally (process.exit right after fetch trips a libuv assertion on Windows);
// force exit only if something keeps the loop alive.
process.exitCode = ok ? 0 : 1;
setTimeout(() => process.exit(ok ? 0 : 1), 5000).unref();
