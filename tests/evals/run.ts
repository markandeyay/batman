// NLU eval runner (spec 7.5, 15.1 layer 3). Writes reports/evals/<date>.md and exits nonzero when
// any suite that ran is below target.
//   npx tsx tests/evals/run.ts                  code words always; LLM suites if ANTHROPIC_API_KEY
//   npx tsx tests/evals/run.ts --codewords-only offline only, report in reports/evals/offline/ (ignored)
// Targets: code words 100% recall and < 0.5% false positives on the benign corpus; classifier
// >= 98% accuracy with zero NOT_OK classified OK; intake >= 95% field accuracy.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchCodeWords } from "../../apps/server/src/pipeline/codewords.js";
import { classifyReply } from "../../apps/server/src/nlu/classifyReply.js";
import { extractPlan } from "../../apps/server/src/nlu/extractPlan.js";
import { createLlmProvider, type LlmProvider } from "../../apps/server/src/nlu/llm.js";
import { wallTime } from "../../apps/server/src/geo/timezone.js";
import { EVAL_PAIRS, generateCodewordCases } from "./codewordCases.js";
import type { ReplyCase } from "./replies.source.js";
import type { IntakeCase } from "./generate.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dataDir = join(here, "data");

const TARGETS = {
  codewordRecall: 1.0,
  codewordFpRate: 0.005,
  classifierAccuracy: 0.98,
  classifierNotOkAsOk: 0,
  intakeFieldAccuracy: 0.95,
};

interface SuiteResult {
  name: string;
  ran: boolean;
  pass: boolean;
  lines: string[];
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(2)}%`;
}

// ---------- code words (offline) ----------

function runCodewords(): SuiteResult {
  const cases = generateCodewordCases();
  const misses = cases.filter((c) => {
    const m = matchCodeWords(c.text, EVAL_PAIRS[c.pair]!, { fromVoice: c.fromVoice });
    return (m?.kind ?? null) !== c.expected;
  });
  const benign = readFileSync(join(dataDir, "benign.txt"), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const fpByPair = EVAL_PAIRS.map((pair) => benign.filter((t) => matchCodeWords(t, pair) !== null));
  const fpVoiceByPair = EVAL_PAIRS.map((pair) => benign.filter((t) => matchCodeWords(t, pair, { fromVoice: true }) !== null));
  const anyFp = benign.filter((t) => EVAL_PAIRS.some((p) => matchCodeWords(t, p) !== null));
  const worstFp = Math.max(...fpByPair.map((f) => f.length));
  const recall = (cases.length - misses.length) / cases.length;
  const worstRate = worstFp / benign.length;
  const byVariant = new Map<string, { n: number; ok: number }>();
  for (const c of cases) {
    const v = byVariant.get(c.variant) ?? { n: 0, ok: 0 };
    v.n++;
    if (!misses.includes(c)) v.ok++;
    byVariant.set(c.variant, v);
  }
  const pass = recall >= TARGETS.codewordRecall && worstRate < TARGETS.codewordFpRate;
  const lines = [
    `- Positive cases: ${cases.length} across ${EVAL_PAIRS.length} code word pairs (${EVAL_PAIRS.length * 2} code words)`,
    `- Recall: ${pct(cases.length - misses.length, cases.length)} (target 100%)`,
    `- Benign corpus: ${benign.length} messages`,
    `- False positives, worst pair: ${worstFp} (${pct(worstFp, benign.length)}, target < 0.5%)`,
    `- False positives, average per pair: ${pct(fpByPair.reduce((a, f) => a + f.length, 0) / EVAL_PAIRS.length, benign.length)}`,
    `- Messages matching any of the ${EVAL_PAIRS.length} pairs: ${anyFp.length} (${pct(anyFp.length, benign.length)})`,
    `- Informational, benign corpus treated as voice transcripts (phonetic pass on), worst pair: ${Math.max(...fpVoiceByPair.map((f) => f.length))}`,
    "",
    "| Variant | Cases | Detected |",
    "|---|---|---|",
    ...[...byVariant.entries()].map(([v, s]) => `| ${v} | ${s.n} | ${pct(s.ok, s.n)} |`),
  ];
  if (misses.length > 0) {
    lines.push("", "Missed cases:", ...misses.slice(0, 50).map((m) => `- pair ${m.pair} ${m.variant}${m.fromVoice ? " (voice)" : ""}: "${m.text}" expected ${m.expected}`));
  }
  const fpLines = fpByPair.flatMap((f, i) => f.map((t) => `- pair ${i} (${EVAL_PAIRS[i]!.exit} / ${EVAL_PAIRS[i]!.alert}): "${t}"`));
  if (fpLines.length > 0) lines.push("", "False positives:", ...fpLines.slice(0, 50));
  return { name: "Code words (spec 9.1)", ran: true, pass, lines };
}

// ---------- classifier rule fallback (offline, spec 9.3 "model call fails") ----------

async function runRuleFallback(): Promise<SuiteResult> {
  const cases = readJsonl<ReplyCase>("replies.jsonl");
  let correct = 0;
  const unsafe: string[] = [];
  for (const c of cases) {
    const r = await classifyReply({ text: c.text, fromVoice: c.fromVoice === true, state: "CHECKING" }, null);
    if (r.label === c.label && (c.label !== "COMMAND" || r.command === c.command)) correct++;
    if (c.label === "NOT_OK" && r.label === "OK") unsafe.push(`- "${c.text}"`);
  }
  const lines = [
    `- Labeled replies: ${cases.length}, no model (every reply goes through the rule pre-pass and weak rules)`,
    `- Accuracy without a model (informational, unclear replies become AMBIGUOUS): ${pct(correct, cases.length)}`,
    `- NOT_OK classified OK: ${unsafe.length} (target 0)`,
    ...(unsafe.length > 0 ? ["", ...unsafe] : []),
  ];
  return { name: "Reply classifier rule fallback, no model (spec 9.3)", ran: true, pass: unsafe.length === 0, lines };
}

// ---------- LLM suites ----------

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(join(dataDir, file), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

async function runClassifier(llm: LlmProvider): Promise<SuiteResult> {
  const cases = readJsonl<ReplyCase>("replies.jsonl");
  const results = await pool(cases, 4, async (c) => {
    const r = await classifyReply({ text: c.text, fromVoice: c.fromVoice === true, state: "CHECKING", lastPrompt: "Hey, everything good?" }, llm);
    const ok = r.label === c.label && (c.label !== "COMMAND" || r.command === c.command);
    return { c, r, ok };
  });
  const correct = results.filter((x) => x.ok).length;
  const notOkAsOk = results.filter((x) => x.c.label === "NOT_OK" && x.r.label === "OK");
  const fallbacks = results.filter((x) => x.r.source === "fallback").length;
  const acc = correct / cases.length;
  const pass = acc >= TARGETS.classifierAccuracy && notOkAsOk.length === TARGETS.classifierNotOkAsOk;
  const confusion = new Map<string, number>();
  for (const x of results) confusion.set(`${x.c.label} -> ${x.r.label}`, (confusion.get(`${x.c.label} -> ${x.r.label}`) ?? 0) + 1);
  const lines = [
    `- Labeled replies: ${cases.length}`,
    `- Accuracy: ${pct(correct, cases.length)} (target >= 98%)`,
    `- NOT_OK classified OK: ${notOkAsOk.length} (target 0)`,
    `- Model failures that used the rule fallback: ${fallbacks}`,
    "",
    "| Expected -> Got | Count |",
    "|---|---|",
    ...[...confusion.entries()].sort().map(([k, v]) => `| ${k} | ${v} |`),
  ];
  const wrong = results.filter((x) => !x.ok);
  if (wrong.length > 0) {
    lines.push("", "Errors:", ...wrong.map((x) => `- [${x.c.tag}] "${x.c.text}" expected ${x.c.label}${x.c.command ? `/${x.c.command}` : ""}, got ${x.r.label}${x.r.command ? `/${x.r.command}` : ""} (${x.r.source}${x.r.postCheck ? `, ${x.r.postCheck}` : ""})`));
  }
  return { name: "Reply classifier (spec 9.3)", ran: true, pass, lines };
}

function localIso(d: Date, tz: string): string {
  const w = wallTime(d, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}`;
}

function venueMatches(got: string | null, want: string): boolean {
  if (!got) return false;
  const n = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9 ]/g, "").trim();
  return n(got).includes(n(want)) || n(want).includes(n(got));
}

async function runIntake(llm: LlmProvider): Promise<SuiteResult> {
  const cases = readJsonl<IntakeCase>("intake.jsonl");
  let fields = 0;
  let correct = 0;
  const perField = new Map<string, { n: number; ok: number }>();
  const errors: string[] = [];
  await pool(cases, 4, async (c) => {
    const out = await extractPlan({ messages: [c.text], now: new Date(c.now), tz: c.tz }, llm);
    const e = out.extraction;
    for (const [k, want] of Object.entries(c.expected)) {
      let got: unknown;
      let ok: boolean;
      if (k === "startLocal") {
        got = out.time.startAt ? localIso(out.time.startAt, c.tz) : null;
        ok = got === want;
      } else if (k === "venueText") {
        got = e.venueText;
        ok = venueMatches(e.venueText, String(want));
      } else if (k === "counterpartName" || k === "counterpartSource") {
        got = e[k];
        ok = typeof got === "string" && got.toLowerCase() === String(want).toLowerCase();
      } else {
        got = (e as Record<string, unknown>)[k];
        ok = got === want;
      }
      fields++;
      if (ok) correct++;
      const f = perField.get(k) ?? { n: 0, ok: 0 };
      f.n++;
      if (ok) f.ok++;
      perField.set(k, f);
      if (!ok) errors.push(`- ${c.id} ${k}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)} ("${c.text}")`);
    }
  });
  const acc = correct / fields;
  const pass = acc >= TARGETS.intakeFieldAccuracy;
  const lines = [
    `- First messages: ${cases.length}, scored fields: ${fields}`,
    `- Field accuracy: ${pct(correct, fields)} (target >= 95%)`,
    "",
    "| Field | Scored | Correct |",
    "|---|---|---|",
    ...[...perField.entries()].map(([k, s]) => `| ${k} | ${s.n} | ${pct(s.ok, s.n)} |`),
  ];
  if (errors.length > 0) lines.push("", "Errors:", ...errors.slice(0, 80));
  return { name: "Plan extraction (spec 9.2)", ran: true, pass, lines };
}

// ---------- main ----------

function loadEnvQuietly(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file); // values are never printed
  } catch {
    /* ignore */
  }
}

async function main(): Promise<number> {
  const codewordsOnly = process.argv.includes("--codewords-only") || process.argv.includes("--offline");
  const suites: SuiteResult[] = [runCodewords(), await runRuleFallback()];
  if (codewordsOnly) {
    suites.push({ name: "LLM suites", ran: false, pass: true, lines: ["- Skipped: --codewords-only"] });
  } else {
    loadEnvQuietly();
    const llm = process.env.ANTHROPIC_API_KEY ? createLlmProvider({ ...process.env, LLM_PROVIDER: process.env.LLM_PROVIDER ?? "anthropic" }) : null;
    if (!llm) {
      console.log("LLM evals skipped: ANTHROPIC_API_KEY is not set (add it to .env to run them).");
      suites.push({ name: "LLM suites", ran: false, pass: true, lines: ["- Skipped: ANTHROPIC_API_KEY not set"] });
    } else {
      suites.push(await runClassifier(llm));
      suites.push(await runIntake(llm));
    }
  }

  const now = new Date();
  const date = localIso(now, Intl.DateTimeFormat().resolvedOptions().timeZone).slice(0, 10);
  const md = [
    `# NLU evals ${date}`,
    "",
    `Generated by tests/evals/run.ts at ${now.toISOString()}. Targets from spec 7.5.`,
    "",
    ...suites.flatMap((s) => [`## ${s.name}: ${s.ran ? (s.pass ? "PASS" : "FAIL") : "SKIPPED"}`, "", ...s.lines, ""]),
  ].join("\n");
  // Offline runs (pnpm verify, every time) go to an ignored folder so they never overwrite the
  // tracked report from a paid LLM run on the same day.
  const outDir = codewordsOnly ? join(root, "reports", "evals", "offline") : join(root, "reports", "evals");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${date}.md`);
  writeFileSync(outFile, md);
  for (const s of suites) console.log(`${s.ran ? (s.pass ? "PASS" : "FAIL") : "SKIP"}  ${s.name}`);
  for (const l of suites[0]!.lines.slice(0, 6)) console.log(`      ${l}`);
  console.log(`Report: ${outFile}`);
  return suites.every((s) => s.pass) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
