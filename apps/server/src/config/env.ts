// Environment loader (spec Section 19). Validates with zod; never logs values.
// Loads <repo>/.env via process.loadEnvFile when present; real environment variables win.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const E164_RE = /^\+[1-9]\d{6,14}$/;
const e164 = z.string().regex(E164_RE, "must be E.164 like +19195550100");
const optE164 = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined))
  .refine((v) => v === undefined || E164_RE.test(v), "must be E.164 like +19195550100");
const flag = z
  .enum(["0", "1", "true", "false", ""])
  .default("0")
  .transform((v) => v === "1" || v === "true");
const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

export const EnvSchema = z
  .object({
    SPECTRUM_PROJECT_ID: z.string().min(1),
    SPECTRUM_PROJECT_SECRET: z.string().min(1),
    IMESSAGE_GRPC_ADDRESS: z.string().default("imessage.spectrum.photon.codes:443"),
    BATMAN_LINE_E164: e164,

    LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
    ANTHROPIC_API_KEY: optStr,
    ANTHROPIC_WORKSPACE_ID: optStr,
    OPENAI_API_KEY: optStr,
    OPENAI_BASE_URL: optStr,
    LLM_MODEL_SMART: z.string().min(1),
    LLM_MODEL_FAST: optStr,
    STT_MODEL: optStr,
    TTS_MODEL: optStr,
    TTS_VOICE: optStr,

    LIVEKIT_URL: optStr,
    LIVEKIT_API_KEY: optStr,
    LIVEKIT_API_SECRET: optStr,
    LIVEKIT_SIP_TRUNK_ID: optStr,

    GEOCODER: z.enum(["nominatim", "mapbox", "google"]).default("nominatim"),
    GEOCODER_API_KEY: optStr,
    FFMPEG_PATH: optStr,
    DATABASE_PATH: z.string().default("./data/batman.db"),
    DEFAULT_TZ: z.string().default("America/New_York"),
    TIME_SCALE: z.coerce.number().positive().default(1),
    LOCATION_SOURCE: z.enum(["findmy", "pin", "replay", "none"]).default("findmy"),
    REPLAY_TRACK: optStr,
    ENABLE_TERMINAL: flag,
    DEMO_MODE: flag,
    TEST_MODE: flag,
    TEST_CONTROL_PORT: z.coerce.number().int().min(1024).max(65535).default(4747),
    ADMIN_NUMBERS: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []))
      .pipe(z.array(e164)),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),

    HUMAN_IPHONE_E164: optE164,
    TEST_GUARDIAN_E164: optE164,
    PROBE_PROJECT_ID: optStr,
    PROBE_PROJECT_SECRET: optStr,
    PROBE_LINE_E164: optE164,
    BATMAN_LINE_FOR_PROBE_E164: optE164,
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY)
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "required when LLM_PROVIDER=anthropic" });
    if (env.LLM_PROVIDER === "openai" && !env.OPENAI_API_KEY)
      ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "required when LLM_PROVIDER=openai" });
    if (env.LOCATION_SOURCE === "replay" && !env.REPLAY_TRACK && !env.TEST_MODE && !env.ENABLE_TERMINAL)
      ctx.addIssue({ code: "custom", path: ["REPLAY_TRACK"], message: "required when LOCATION_SOURCE=replay outside test and terminal mode" });
    if ((env.GEOCODER === "mapbox" || env.GEOCODER === "google") && !env.GEOCODER_API_KEY)
      ctx.addIssue({ code: "custom", path: ["GEOCODER_API_KEY"], message: `required for GEOCODER=${env.GEOCODER}` });
  });

export type Env = z.infer<typeof EnvSchema>;

/** Optional capabilities derived from which variables are present. */
export interface Capabilities {
  speech: boolean; // OpenAI STT/TTS
  calls: boolean; // LiveKit SIP trunk configured
  probe: boolean;
}

export function capabilities(env: Env): Capabilities {
  return {
    speech: !!env.OPENAI_API_KEY && !!env.STT_MODEL && !!env.TTS_MODEL && !!env.TTS_VOICE,
    calls: !!env.LIVEKIT_URL && !!env.LIVEKIT_API_KEY && !!env.LIVEKIT_API_SECRET && !!env.LIVEKIT_SIP_TRUNK_ID,
    probe: !!env.PROBE_PROJECT_ID && !!env.PROBE_PROJECT_SECRET,
  };
}

export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

/**
 * Load and validate the environment. On failure throws an Error that lists
 * variable NAMES and reasons only, never values.
 */
export function loadEnv(opts: { root?: string; source?: NodeJS.ProcessEnv } = {}): Env {
  const root = opts.root ?? findRepoRoot();
  if (!opts.source) {
    const file = path.join(root, ".env");
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
  const parsed = EnvSchema.safeParse(opts.source ?? process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new Error(`Invalid environment. Fix these variables in .env:\n  ${problems.join("\n  ")}`);
  }
  const env = parsed.data;
  if (!path.isAbsolute(env.DATABASE_PATH)) env.DATABASE_PATH = path.join(root, env.DATABASE_PATH);
  return env;
}
