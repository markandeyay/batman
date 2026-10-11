// Small talk outside windows (spec 4.1 voice, 9.4 "small talk replies outside windows"). When a
// message does not fit the pending step, the fast model writes one short in-character line that
// acknowledges what the person said; code then steers back to the step with a fixed line.
// Never used in DISCREET_STATES, never for safety-critical copy, never with code words (I8): the
// dialogue only calls this after the deterministic code word pass, and never during code word
// entry. Output passes validateCopy plus a no-comics check, or the fixed fallback is used.
import { z } from "zod";
import type { LlmProvider } from "../nlu/llm.js";
import { loadPrompt } from "../nlu/prompts.js";
import { COPY_TIMEOUT_MS, factValues, type CopyFacts } from "./copy.js";
import { validateCopy } from "./discretion.js";

export type SmallTalkStep = "ask_name" | "ask_guardian" | "questions" | "confirm" | "idle" | "armed" | "awaiting";

/** What Batman is waiting for at each step (model context and grounding). */
export const STEP_CONTEXT: Record<SmallTalkStep, string> = {
  ask_name: "You are setting them up and just asked what to call them.",
  ask_guardian: "You are setting them up and asked who their backup should be (a name and number, or a contact card).",
  questions: "You are planning their meetup and asked a follow-up question about it.",
  confirm: "You sent them their plan summary and are waiting for them to reply GO or say what to change.",
  idle: "They have no plan right now. They text you before meeting someone new.",
  armed: "Their plan is locked in and you will look out for them when it starts.",
  awaiting: "Their plan is ready but their backup has not said yes yet, so it is not locked in.",
};

/** Grounded capability facts the model may use (and the validator accepts). */
export const CAPABILITY_FACTS: readonly string[] = [
  "An automated assistant, not a person and not 911.",
  "Before you meet someone new (a date, a Marketplace pickup or sale, an apartment viewing), text me who, where, and when.",
  "During the meetup I quietly look out for you.",
  "If something seems off and you don't answer me, I text you, then call you, then text your backup.",
  "Your backup only hears from me if you might need help.",
  "You pick two secret code words: an exit word that makes your phone ring with a fake call, and a word that quietly gets your backup.",
];

export type ChatTopic = "who" | "what" | "who_texted" | "thanks" | "greeting" | "how_are_you" | "laugh" | "complaint" | "question";

/** Deterministic topic of an off-script message, or null when it reads like an answer. */
export function chatTopic(text: string): ChatTopic | null {
  const n = text.toLowerCase().normalize("NFKC").replace(/[’‘]/g, "'").trim();
  if (!n) return null;
  if (/\bwho\b.*\b(text|texted|texting|contact|contacted|notif\w*|tell|told|call|called|message|messaged|hear|know)\b/.test(n)) return "who_texted";
  if (/\b(who|what) (are|r) (you|u)\b|\bwho is this\b|\bwho dis\b|\bare (you|u) (a )?(bot|real|human|person|robot|ai)\b/.test(n)) return "who";
  if (/\bwhat (can|do|does) (you|u)\b|\bhow does (this|it|that) work\b|\bwhat is this\b|\bwhat do i do\b/.test(n)) return "what";
  if (/^(thanks|thank you|thank u|thx|ty|tysm|appreciate it|appreciate you)\b/.test(n)) return "thanks";
  if (/^(hi|hey|hello|yo|sup|hiya|howdy|heyy+|hii+)\b[\s!.]*$/.test(n)) return "greeting";
  if (/\bhow (are|r) (you|u)\b|\bhow'?s it going\b|\bwyd\b|\bwhat'?s up\b/.test(n)) return "how_are_you";
  if (/^(lol|lmao|lmfao|haha+|hehe+|rofl)\b|^[\u{1F602}\u{1F923}]+$/u.test(n)) return "laugh";
  if (/\b(annoying|stupid|dumb|useless|broken|not working|doesn'?t work|not listening|ignor\w*|wtf|ugh)\b/.test(n)) return "complaint";
  if (/\?\s*$/.test(n) || /^(who|what|why|how|when|where|can|could|do|does|is|are|will|would|should|wait)\b/.test(n)) return "question";
  return null;
}

/** DC Comics references are off brand (and not ours to use). */
const COMICS_RE =
  /\b(gotham|joker|robin|alfred|bruce|wayne|batmobile|batcave|bat[\s-]?signal|dark knight|catwoman|riddler|penguin|dc comics|caped crusader|commissioner gordon|bane)\b/i;

const SmallTalkOutput = z.object({ text: z.string().max(600) });

export interface SmallTalkInput {
  message: string;
  step: SmallTalkStep;
  facts: CopyFacts;
}

export interface SmallTalkResult {
  text: string;
  source: "model";
}

/** Validate a small talk line (spec 9.4 rules plus no comics references and short). */
export function validateSmallTalk(text: string, grounding: readonly string[]): string[] {
  const reasons = [...validateCopy(text, grounding, { maxChars: 200 }).reasons];
  if (COMICS_RE.test(text)) reasons.push("comics");
  if (/\breply go\b/i.test(text)) reasons.push("steer_in_reply"); // code adds the steer line
  return reasons;
}

/**
 * One short in-character line answering an off-script message. Returns null when there is no
 * model, it fails or times out (6 s), or its output fails validation: callers use the fixed
 * smalltalk_reply fallback.
 */
export async function smallTalkReply(input: SmallTalkInput, llm: LlmProvider | null, opts: { timeoutMs?: number } = {}): Promise<SmallTalkResult | null> {
  if (!llm || !input.message.trim()) return null;
  const facts = {
    userName: input.facts.userName ?? null,
    guardianName: input.facts.guardianName ?? null,
    counterpartName: input.facts.counterpartName ?? null,
    plan: input.facts.other ?? [],
    whatIDo: CAPABILITY_FACTS,
  };
  try {
    const out = await llm.parse({
      task: "smallTalk",
      tier: "fast",
      effort: "low",
      system: loadPrompt("smallTalk"),
      user: JSON.stringify({ message: input.message, step: STEP_CONTEXT[input.step], facts }),
      schema: SmallTalkOutput,
      timeoutMs: opts.timeoutMs ?? COPY_TIMEOUT_MS,
      maxTokens: 200,
    });
    const text = out.text.trim();
    const grounding = [input.message, STEP_CONTEXT[input.step], ...CAPABILITY_FACTS, ...factValues(input.facts)];
    if (validateSmallTalk(text, grounding).length > 0) return null;
    return { text, source: "model" };
  } catch {
    return null;
  }
}
