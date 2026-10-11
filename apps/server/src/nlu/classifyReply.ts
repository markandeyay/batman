// Reply classification (spec 9.3, 6.5). Rule pre-pass wins over the model; the fast model has a
// 6 s budget; post-checks never let a hint of distress become OK. On any model failure the
// rule result is used, else AMBIGUOUS. The label never decides escalation by itself (I7): the
// plan engine does, from the label.
import { z } from "zod";
import type { PlanState, PlanType } from "../contracts.js";
import type { LlmProvider } from "./llm.js";
import { loadPrompt } from "./prompts.js";
import { hasDistressLexicon, isExplicitDistress, isNegative, matchKeywordRule, weakReplyLabel } from "./rules.js";

export const REPLY_LABELS = ["OK", "NOT_OK", "AMBIGUOUS", "COMMAND"] as const;
export const REPLY_COMMANDS = ["done", "home", "extend", "cancel", "moving"] as const;

/** Spec 9.3 output. Optional fields are nullable so the schema works with structured output. */
export const ReplyClassification = z.object({
  label: z.enum(REPLY_LABELS),
  command: z.enum(REPLY_COMMANDS).nullable(),
  extendMin: z.number().int().min(5).max(240).nullable(),
  confidence: z.number().min(0).max(1),
});
export type ReplyClassification = z.infer<typeof ReplyClassification>;

export const CLASSIFY_TIMEOUT_MS = 6000;
export const OK_MIN_CONFIDENCE = 0.8;

export interface ClassifyInput {
  text: string;
  fromVoice?: boolean;
  /** Plan state and the last thing Batman said, for the model's context. */
  state?: PlanState | null;
  planType?: PlanType | null;
  lastPrompt?: string | null;
}

export interface ReplyResult {
  label: (typeof REPLY_LABELS)[number];
  command: (typeof REPLY_COMMANDS)[number] | null;
  extendMin: number | null;
  /** For command "moving": the place text, when the rule caught it. */
  venueText: string | null;
  confidence: number;
  /** True for explicit distress phrases (spec 4.6): the engine jumps to L3 plus the exit call. */
  distress: boolean;
  source: "rule" | "model" | "fallback";
  /** Why a model answer was changed, for audit logs. */
  postCheck?: "low_confidence" | "distress_lexicon" | "invalid_command";
}

function result(p: Partial<ReplyResult> & Pick<ReplyResult, "label" | "source">): ReplyResult {
  return {
    command: null,
    extendMin: null,
    venueText: null,
    confidence: 1,
    distress: false,
    ...p,
  };
}

/** Deterministic pre-pass (wins over the model). Returns null when no strong rule applies. */
export function rulePrePass(text: string): ReplyResult | null {
  if (isExplicitDistress(text)) return result({ label: "NOT_OK", source: "rule", distress: true });
  const rule = matchKeywordRule(text);
  if (!rule) return null;
  switch (rule.kind) {
    case "distress":
      return result({ label: "NOT_OK", source: "rule", distress: true });
    case "extend":
      return result({ label: "COMMAND", command: "extend", extendMin: rule.minutes, source: "rule" });
    case "home":
      return result({ label: "COMMAND", command: "home", source: "rule" });
    case "done":
      return result({ label: "COMMAND", command: "done", source: "rule" });
    case "cancel":
      return result({ label: "COMMAND", command: "cancel", source: "rule" });
    case "moving":
      return result({ label: "COMMAND", command: "moving", venueText: rule.venueText, source: "rule" });
    case "help":
      // Bare "help" during CHECKING/OVERTIME is explicit distress (spec 4.6).
      return result({ label: "NOT_OK", source: "rule", distress: true });
    default:
      return null;
  }
}

const FEAR_EMOJI = /^[\s\u{1F630}\u{1F628}\u{1F631}\u{1F61F}\u{1F625}\u{1F622}\u{1F62D}\u{1F198}\u{1F616}\u{1F623}\u{1F627}\u{1F626}\u{1FAE3}]+$/u;
const POSITIVE_EMOJI_ONLY = /^[\s\u{1F44D}\u{2764}\u{FE0F}\u{1F602}\u{1F60A}\u{1F642}\u{1F44C}\u{1F60E}\u{1F970}\u{1F60D}\u{1F923}\u{1F600}\u{1F601}\u{1F604}\u{263A}\u{1F917}\u{2705}]+$/u;

/** True when the assistant's last message was a wellbeing check ("everything good?"), not "Still out?". */
function askedWellbeing(input: ClassifyInput): boolean {
  if (input.state === "OVERTIME") return false;
  const p = (input.lastPrompt ?? "").toLowerCase();
  if (/still out|reply \+30|made it there|new spot/.test(p)) return false;
  return true;
}

/**
 * Deterministic answers to a wellbeing check that need no model (spec 9.3 rule pre-pass, extended):
 * whole-message clear positives become OK, bare negatives and fear emoji become NOT_OK.
 * Runs after the distress and command rules, so a distress phrase always wins.
 */
export function clearReplyRule(input: ClassifyInput): ReplyResult | null {
  const text = input.text.trim();
  if (FEAR_EMOJI.test(text)) return result({ label: "NOT_OK", source: "rule", confidence: 0.95 });
  if (askedWellbeing(input) && isNegative(text)) return result({ label: "NOT_OK", source: "rule", confidence: 0.9 });
  if (hasDistressLexicon(text)) return null;
  // A question back ("ok?", "k?") is never a clear positive.
  if (/\?\s*$/.test(text)) return null;
  if (POSITIVE_EMOJI_ONLY.test(text)) return result({ label: "OK", source: "rule", confidence: 0.95 });
  const weak = weakReplyLabel(text);
  if (weak === "OK") return result({ label: "OK", source: "rule", confidence: 0.95 });
  return null;
}

function fallback(text: string): ReplyResult {
  const weak = weakReplyLabel(text);
  return result({ label: weak ?? "AMBIGUOUS", source: "fallback", confidence: weak ? 0.7 : 0 });
}

export async function classifyReply(
  input: ClassifyInput,
  llm: LlmProvider | null,
  opts: { timeoutMs?: number } = {},
): Promise<ReplyResult> {
  const pre = rulePrePass(input.text);
  if (pre) return pre;
  const clear = clearReplyRule(input);
  if (clear) return clear;
  if (!llm) return fallback(input.text);

  let out: ReplyClassification;
  try {
    out = await llm.parse({
      task: "classifyReply",
      tier: "fast",
      effort: "low",
      system: loadPrompt("classifyReply"),
      user: JSON.stringify({
        message: input.text,
        fromVoiceTranscript: input.fromVoice === true,
        planState: input.state ?? null,
        meetupType: input.planType ?? null,
        lastMessageFromAssistant: input.lastPrompt ?? null,
      }),
      schema: ReplyClassification,
      timeoutMs: opts.timeoutMs ?? CLASSIFY_TIMEOUT_MS,
      maxTokens: 400,
    });
  } catch {
    return fallback(input.text);
  }

  const distressHint = hasDistressLexicon(input.text);
  if (out.label === "COMMAND") {
    if (!out.command) return result({ label: "AMBIGUOUS", source: "model", confidence: out.confidence, postCheck: "invalid_command" });
    if (distressHint) return result({ label: "AMBIGUOUS", source: "model", confidence: out.confidence, postCheck: "distress_lexicon" });
    return result({
      label: "COMMAND",
      command: out.command,
      extendMin: out.command === "extend" ? (out.extendMin ?? 30) : null,
      confidence: out.confidence,
      source: "model",
    });
  }
  if (out.label === "OK") {
    if (distressHint) return result({ label: "AMBIGUOUS", source: "model", confidence: out.confidence, postCheck: "distress_lexicon" });
    if (out.confidence < OK_MIN_CONFIDENCE) {
      return result({ label: "AMBIGUOUS", source: "model", confidence: out.confidence, postCheck: "low_confidence" });
    }
  }
  return result({ label: out.label, confidence: out.confidence, source: "model" });
}
