// LLM-phrased intake questions (spec 9.4, 4.4.3, 4.4.4). The dialogue manager (code) picks the
// question IDs; the fast model may only rephrase them. Output passes validateCopy or the fixed
// bank text is used instead.
import { z } from "zod";
import type { LlmProvider } from "../nlu/llm.js";
import { loadPrompt } from "../nlu/prompts.js";
import { validateCopy } from "./discretion.js";

export const QUESTION_IDS = [
  "start_time",
  "venue",
  "venue_pin",
  "type",
  "duration",
  "counterpart_name",
  "transport",
  "date_first_time",
  "date_name_source",
  "mkt_buy_sell",
  "mkt_move_public",
  "mkt_cash_tip",
  "viewing_agent",
  "viewing_paid",
  "other_who_how_long",
] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

/** Fixed bank (spec 4.4.4). These are also the fallback copy. */
export const QUESTION_BANK: Record<QuestionId, string> = {
  start_time: "What time are you meeting?",
  venue: "Where are you meeting?",
  venue_pin: "Can you drop a pin for the spot so I know exactly where it is?",
  type: "What kind of meetup is it: a date, a Marketplace buy or sell, an apartment viewing, or something else?",
  duration: "How long do you think it'll take?",
  counterpart_name: "What's their name?",
  transport: "How are you getting there and back?",
  date_first_time: "First time meeting in person?",
  date_name_source: "What's their name, and where'd you meet?",
  mkt_buy_sell: "Buying or selling? What's the item?",
  mkt_move_public: "Want to move it to a public spot? A lot of police stations have safe exchange zones.",
  mkt_cash_tip: "If it's cash, count it somewhere visible.",
  viewing_agent: "Is a landlord or agent meeting you there?",
  viewing_paid: "Have you paid anything yet?",
  other_who_how_long: "Who are you meeting, and roughly how long?",
};

export interface CopyItem {
  /** A bank question, or a stated default / tip line already rendered by code. */
  id: QuestionId | "statement";
  text: string;
}

export function questionItem(id: QuestionId): CopyItem {
  return { id, text: QUESTION_BANK[id] };
}

export function fallbackText(items: readonly CopyItem[]): string {
  return items.map((i) => i.text).join(" ");
}

const PhraseOutput = z.object({ text: z.string().max(600) });

export interface PhraseResult {
  text: string;
  source: "model" | "template";
  rejected?: string[];
}

/**
 * Known facts for LLM copy, labeled so the model never confuses the user (the person it is
 * texting) with the person they are meeting (live bug: "Nice, you're meeting Marky").
 */
export interface CopyFacts {
  /** The person Batman is texting. Never the counterpart; never named in intake questions. */
  userName?: string | null;
  counterpartName?: string | null;
  counterpartSource?: string | null;
  venueText?: string | null;
  guardianName?: string | null;
  /** Other grounded strings (plan summary, capability lines). */
  other?: readonly string[];
}

export function factValues(f: CopyFacts | readonly string[]): string[] {
  if (Array.isArray(f)) return [...(f as readonly string[])];
  const c = f as CopyFacts;
  return [c.userName, c.counterpartName, c.counterpartSource, c.venueText, c.guardianName, ...(c.other ?? [])].filter(
    (x): x is string => typeof x === "string" && x.trim() !== "",
  );
}

/** True when `text` uses the user's first name as a word (and the counterpart is not namesake). */
export function namesUser(text: string, facts: CopyFacts): boolean {
  const first = (facts.userName ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first.length < 2) return false;
  const cp = (facts.counterpartName ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (cp === first) return false;
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, "iu").test(text);
}

/** Copy LLM budget (item: keep latency low): fast model, effort low, 6 s, template fallback. */
export const COPY_TIMEOUT_MS = 6000;

/**
 * Phrase the follow-up message. `facts` are the known plan values (names, places, times) the
 * model may mention; anything else it adds fails validation and the bank text is used.
 */
export async function phraseQuestions(
  items: readonly CopyItem[],
  facts: CopyFacts | readonly string[],
  llm: LlmProvider | null,
  opts: { timeoutMs?: number } = {},
): Promise<PhraseResult> {
  const fallback = fallbackText(items);
  if (!llm || items.length === 0) return { text: fallback, source: "template" };
  const labeled: CopyFacts = Array.isArray(facts) ? { other: facts as readonly string[] } : (facts as CopyFacts);
  try {
    const out = await llm.parse({
      task: "phraseQuestions",
      tier: "fast",
      effort: "low",
      system: loadPrompt("phraseQuestions"),
      user: JSON.stringify({
        items: items.map((i) => i.text),
        userName: labeled.userName ?? null,
        counterpartName: labeled.counterpartName ?? null,
        venue: labeled.venueText ?? null,
        knownFacts: factValues(facts),
      }),
      schema: PhraseOutput,
      timeoutMs: opts.timeoutMs ?? COPY_TIMEOUT_MS,
      maxTokens: 300,
    });
    const text = out.text.trim();
    const grounding = [...items.map((i) => i.text), ...factValues(facts)];
    const v = validateCopy(text, grounding);
    const questions = items.filter((i) => i.id !== "statement").length;
    const reasons = [...v.reasons];
    if (questions > 0 && !text.includes("?")) reasons.push("no_question");
    if (namesUser(text, labeled)) reasons.push("names_user");
    if (reasons.length > 0) return { text: fallback, source: "template", rejected: reasons };
    return { text, source: "model" };
  } catch {
    return { text: fallback, source: "template", rejected: ["llm_error"] };
  }
}
