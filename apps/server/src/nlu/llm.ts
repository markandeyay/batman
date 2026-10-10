// LlmProvider interface (spec 9.2): schemas and validators are provider independent.
// Selected by LLM_PROVIDER: "anthropic" (chosen, DECISIONS.md) or "openai" (stub, not configured).
// The LLM never decides escalation (I7); callers treat every failure as "no answer".
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export type ModelTier = "smart" | "fast";

export interface LlmRequest<S extends z.ZodType> {
  /** Which configured model to use: LLM_MODEL_SMART or LLM_MODEL_FAST. */
  tier: ModelTier;
  system: string;
  user: string;
  schema: S;
  /** Hard wall-clock budget in milliseconds, including any retries. */
  timeoutMs: number;
  maxTokens?: number;
  /** Reasoning effort. Use "low" for latency-sensitive calls (classifier). */
  effort?: "low" | "medium" | "high";
  /** Short name for logs and fakes ("extractPlan", "classifyReply", "phraseQuestions"). */
  task: string;
}

export interface LlmProvider {
  readonly name: string;
  /** Returns schema-validated output or throws (timeout, refusal, invalid output, API error). */
  parse<S extends z.ZodType>(req: LlmRequest<S>): Promise<z.infer<S>>;
}

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM call exceeded ${ms} ms`);
    this.name = "LlmTimeoutError";
  }
}

/** Race a promise against a timer; aborts the controller on timeout. */
export async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new LlmTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([run(ac.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AnthropicProviderOptions {
  apiKey: string;
  modelSmart: string;
  modelFast: string;
}

/**
 * Anthropic Messages API with structured output (docs/PHOTON_NOTES.md section E):
 * client.messages.parse with output_config.format = zodOutputFormat(schema). Timeouts are in
 * milliseconds; maxRetries is 0 so the budget is the real wall clock.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  constructor(private readonly opts: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
  }

  async parse<S extends z.ZodType>(req: LlmRequest<S>): Promise<z.infer<S>> {
    const model = req.tier === "smart" ? this.opts.modelSmart : this.opts.modelFast;
    return withTimeout(req.timeoutMs, async (signal) => {
      const msg = await this.client.messages.parse(
        {
          model,
          max_tokens: req.maxTokens ?? 1024,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { format: zodOutputFormat(req.schema), effort: req.effort ?? "low" },
        },
        { timeout: req.timeoutMs, maxRetries: 0, signal },
      );
      if (msg.stop_reason === "refusal") throw new Error("LLM refused");
      if (msg.parsed_output === null || msg.parsed_output === undefined) throw new Error("LLM returned no parsed output");
      return req.schema.parse(msg.parsed_output) as z.infer<S>;
    });
  }
}

/** Placeholder so LLM_PROVIDER=openai fails loudly instead of silently. */
export class OpenAIProviderStub implements LlmProvider {
  readonly name = "openai";
  async parse<S extends z.ZodType>(_req: LlmRequest<S>): Promise<z.infer<S>> {
    throw new Error("OpenAI LLM provider not configured (LLM_PROVIDER=openai). Use LLM_PROVIDER=anthropic.");
  }
}

export interface LlmEnv {
  LLM_PROVIDER?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  LLM_MODEL_SMART?: string | undefined;
  LLM_MODEL_FAST?: string | undefined;
}

/**
 * Build the provider from env. Returns null when the selected provider has no key, so callers
 * fall back to deterministic rules (classifier) or templates (copy).
 */
export function createLlmProvider(env: LlmEnv): LlmProvider | null {
  const provider = (env.LLM_PROVIDER ?? "anthropic").trim().toLowerCase();
  if (provider === "openai") return new OpenAIProviderStub();
  if (provider !== "anthropic") throw new Error(`Unknown LLM_PROVIDER "${provider}"`);
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const smart = env.LLM_MODEL_SMART?.trim() || "claude-opus-5-5";
  const fast = env.LLM_MODEL_FAST?.trim() || "claude-haiku-5-5";
  return new AnthropicProvider({ apiKey, modelSmart: smart, modelFast: fast });
}

/**
 * Scriptable provider for tests, the terminal chat without a key, and simulations.
 * `handler` receives the request and returns raw output (validated against the schema) or
 * throws. `delayMs` simulates latency; the provider honours req.timeoutMs like the real one.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake";
  readonly calls: Array<{ task: string; user: string }> = [];
  constructor(
    private readonly handler: (req: LlmRequest<z.ZodType>) => unknown | Promise<unknown>,
    private readonly delayMs = 0,
  ) {}
  async parse<S extends z.ZodType>(req: LlmRequest<S>): Promise<z.infer<S>> {
    this.calls.push({ task: req.task, user: req.user });
    return withTimeout(req.timeoutMs, async () => {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      const out = await this.handler(req as unknown as LlmRequest<z.ZodType>);
      return req.schema.parse(out) as z.infer<S>;
    });
  }
}
