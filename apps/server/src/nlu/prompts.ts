// Loads prompt files from nlu/prompts/*.md (read once, cached). Works under tsx, vitest, and node.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

export type PromptName = "classifyReply" | "extractPlan" | "phraseQuestions" | "smallTalk";

export function loadPrompt(name: PromptName): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = readFileSync(join(here, "prompts", `${name}.md`), "utf8");
  cache.set(name, text);
  return text;
}
