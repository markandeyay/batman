// pnpm doctor: toolchain, env presence (names only), Photon auth, Windows sleep check.
// Never prints secret values. Loads .env itself so it works before the app exists.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

type Check = { name: string; ok: boolean; detail: string; warn?: boolean };
const results: Check[] = [];
const add = (name: string, ok: boolean, detail: string, warn = false) => results.push({ name, ok, detail, warn });

function tryExec(cmd: string, args: string[]): string | null {
  // args are compile-time constants, so one command string is safe and works with .cmd shims on Windows.
  try {
    return execSync([cmd, ...args].join(" "), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

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

// 1. Toolchain
const nodeMajor = Number(process.versions.node.split(".")[0]);
add("node", nodeMajor >= 22, `v${process.versions.node}${nodeMajor >= 22 ? " (LTS ok)" : " (need 22+)"}`);
const pnpm = tryExec("pnpm", ["--version"]);
add("pnpm", !!pnpm, pnpm ?? "not found (run: corepack enable)");
const git = tryExec("git", ["--version"]);
add("git", !!git, git ?? "not found");

const env = loadEnv(path.join(root, ".env"));
const ffmpegBin = env.FFMPEG_PATH || "ffmpeg";
const ff = tryExec(ffmpegBin, ["-version"]);
add("ffmpeg", !!ff, ff ? ff.split("\n")[0]!.slice(0, 60) : "not found (set FFMPEG_PATH or install Gyan.FFmpeg)");

// 2. Env presence (names only)
add(".env file", Object.keys(env).length > 0, Object.keys(env).length > 0 ? `${Object.keys(env).length} variables loaded` : "missing: copy .env.example to .env");
const required = ["SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET", "BATMAN_LINE_E164", "LLM_PROVIDER", "LLM_MODEL_SMART", "GEOCODER", "DATABASE_PATH", "DEFAULT_TZ"];
const llmKey = env.LLM_PROVIDER === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
required.push(llmKey);
const missing = required.filter((k) => !env[k]);
add("required env vars", missing.length === 0, missing.length === 0 ? `all ${required.length} present` : `missing: ${missing.join(", ")}`);

const optionalGroups: Record<string, string[]> = {
  "voice (STT/TTS)": ["OPENAI_API_KEY", "STT_MODEL", "TTS_MODEL", "TTS_VOICE"],
  "calls (LiveKit)": ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"],
  "probe E2E": ["PROBE_PROJECT_ID", "PROBE_PROJECT_SECRET"],
  "live tests": ["HUMAN_IPHONE_E164", "TEST_GUARDIAN_E164"],
};
for (const [group, keys] of Object.entries(optionalGroups)) {
  const absent = keys.filter((k) => !env[k]);
  add(`optional: ${group}`, absent.length === 0, absent.length === 0 ? "configured" : `disabled, blank: ${absent.join(", ")}`, true);
}
for (const k of ["BATMAN_LINE_E164", "HUMAN_IPHONE_E164", "TEST_GUARDIAN_E164", "ADMIN_NUMBERS"]) {
  if (env[k] && !env[k]!.split(",").every((n) => /^\+[1-9]\d{6,14}$/.test(n.trim()))) add(`${k} format`, false, "must be E.164 like +19195550100");
}

// 3. Photon auth (GET /projects/{id}/)
async function photonAuth(): Promise<void> {
  if (!env.SPECTRUM_PROJECT_ID || !env.SPECTRUM_PROJECT_SECRET) { add("photon auth", false, "skipped, credentials missing"); return; }
  const auth = "Basic " + Buffer.from(`${env.SPECTRUM_PROJECT_ID}:${env.SPECTRUM_PROJECT_SECRET}`).toString("base64");
  try {
    const r = await fetch(`https://spectrum.photon.codes/projects/${env.SPECTRUM_PROJECT_ID}/`, { headers: { authorization: auth }, signal: AbortSignal.timeout(15000) });
    if (r.status === 200) {
      const j = (await r.json()) as { data?: { name?: string } };
      const t = await fetch(`https://spectrum.photon.codes/projects/${env.SPECTRUM_PROJECT_ID}/imessage/`, { headers: { authorization: auth }, signal: AbortSignal.timeout(15000) });
      const tj = t.status === 200 ? ((await t.json()) as { data?: { type?: string } }) : {};
      add("photon auth", true, `project "${j.data?.name ?? "?"}", line type ${tj.data?.type ?? "unknown"}`);
    } else {
      add("photon auth", false, `HTTP ${r.status}${r.status === 401 ? " (check SPECTRUM_PROJECT_ID / SECRET)" : ""}`);
    }
  } catch (e) {
    add("photon auth", false, `network error: ${(e as Error).message}`);
  }
}

// 4. Windows sleep (spec Section 17)
function sleepCheck(): void {
  if (process.platform !== "win32") return;
  const out = tryExec("powercfg", ["/query", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE"]);
  if (!out) { add("windows sleep", true, "could not query powercfg", true); return; }
  const ac = out.match(/Current AC Power Setting Index:\s*0x([0-9a-f]+)/i);
  const secs = ac ? parseInt(ac[1]!, 16) : NaN;
  add("windows sleep (AC)", secs === 0, secs === 0 ? "never sleeps on AC" : `sleeps after ${Math.round(secs / 60)} min on AC. For demo: powercfg /change standby-timeout-ac 0`, true);
}

await photonAuth();
sleepCheck();

let hardFail = false;
for (const r of results) {
  const tag = r.ok ? "PASS" : r.warn ? "WARN" : "FAIL";
  if (!r.ok && !r.warn) hardFail = true;
  console.log(`${tag.padEnd(5)} ${r.name.padEnd(28)} ${r.detail}`);
}
console.log(hardFail ? "\ndoctor: problems found" : "\ndoctor: ok");
process.exit(hardFail ? 1 : 0);
