// I7. The LLM never decides to escalate: escalation is decided by the deterministic plan engine
// and risk rules. The LLM extracts structure and writes non-critical copy only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../../apps/server/src/nlu/llm.js";
import { DATE_EXTRACTION, EXTRACTION_BASE, FullStack, type LlmScript } from "../sim/fullstack.js";

const sims: FullStack[] = [];
afterEach(() => sims.splice(0).forEach((s) => s.close()));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("I7 the LLM never decides escalation", () => {
  it("plan, risk, and scheduler code never import the NLU or LLM modules", () => {
    const src = join(import.meta.dirname, "../../apps/server/src");
    for (const dir of ["plan", "risk", "scheduler"]) {
      for (const f of files(join(src, dir))) {
        expect(readFileSync(f, "utf8"), f).not.toMatch(/from\s+["'][^"']*(nlu\/|\/llm|anthropic|openai)/);
      }
    }
  });

  it("the timer-driven ladder runs with zero model calls, and with the model down it still escalates on time", async () => {
    const script: LlmScript = { extract: [{ match: "jordan", out: DATE_EXTRACTION }] };
    const s = new FullStack({ track: "date-overtime", trackMessages: false, llm: script });
    sims.push(s);
    await s.onboard();
    await s.planDate();
    const llm = s.llm as FakeLlmProvider;
    const callsAtArm = llm.calls.length;
    script.down = true;
    await s.runUntil(160);
    expect(llm.calls.length).toBe(callsAtArm);
    expect(s.sends(100)).toEqual(["user:ot_overtime", "user:lad_l1", "user:lad_l2_text", "guardian:gdn_alert", "guardian:gdn_alert_repeat", "guardian:gdn_alert_repeat"]);
  });

  it("a model that calls distress OK cannot stop the distress path (rules win)", async () => {
    const lying = new FakeLlmProvider((req) => {
      if (req.task === "extractPlan") return { ...EXTRACTION_BASE, ...DATE_EXTRACTION };
      if (req.task === "classifyReply") return { label: "OK", command: null, extendMin: null, confidence: 1 };
      throw new Error("no phrasing");
    });
    const s = new FullStack({ track: "date-normal", trackMessages: false, llm: lying });
    sims.push(s);
    await s.onboard();
    await s.planDate();
    s.at(60, "user", "he won't let me leave").at(61, "user", "pineapple");
    await s.runUntil(62);
    expect(s.routes.filter((r) => r.t >= 60).map((r) => r.route)).toEqual(["distress", "codeword_exit"]);
    expect(lying.calls.filter((c) => c.task === "classifyReply")).toEqual([]);
  });

  it("a model that calls everything OK cannot stop a no-reply escalation", async () => {
    const yes = new FakeLlmProvider((req) => {
      if (req.task === "extractPlan") return { ...EXTRACTION_BASE, ...DATE_EXTRACTION };
      return { label: "OK", command: null, extendMin: null, confidence: 1 };
    });
    const s = new FullStack({ track: "date-overtime", trackMessages: false, llm: yes });
    sims.push(s);
    await s.onboard();
    await s.planDate();
    await s.runUntil(154);
    expect(s.sends(150, "guardian")).toEqual(["guardian:gdn_alert"]);
  });
});
