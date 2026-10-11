import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Effect, EngineEvent, LadderClass } from "../../../apps/server/src/contracts.js";
import {
  CLASS_RANK,
  computeHighVigilance,
  isUpgrade,
  l0Template,
  ladderMultiplier,
  nextStep,
  stepDelayMs,
} from "../../../apps/server/src/plan/ladder.js";
import { applyEvent } from "../../../apps/server/src/plan/stateMachine.js";
import type { EnginePlan } from "../../../apps/server/src/plan/types.js";
import { MIN, at, basePlan, ctxAt } from "./helpers.js";

describe("ladder timings (6.4)", () => {
  const table: [LadderClass, number, number, number][] = [
    ["overtime", 10, 5, 3],
    ["soft", 5, 4, 3],
    ["hard", 3, 2, 2],
  ];
  it.each(table)("%s: T1=%i T2=%i T3=%i minutes", (cls, t1, t2, t3) => {
    expect(stepDelayMs(cls, "L1", 1)).toBe(t1 * MIN);
    expect(stepDelayMs(cls, "L2", 1)).toBe(t2 * MIN);
    expect(stepDelayMs(cls, "L3", 1)).toBe(t3 * MIN);
  });

  it("guardian-requested: L2 immediate, T3 3 min", () => {
    expect(stepDelayMs("guardian_requested", "L2", 1)).toBe(0);
    expect(stepDelayMs("guardian_requested", "L3", 1)).toBe(3 * MIN);
  });

  it("multipliers: night x0.7, high vigilance x0.6, both x0.42", () => {
    expect(ladderMultiplier({ night: false, highVigilance: false })).toBe(1);
    expect(ladderMultiplier({ night: true, highVigilance: false })).toBe(0.7);
    expect(ladderMultiplier({ night: false, highVigilance: true })).toBe(0.6);
    expect(ladderMultiplier({ night: true, highVigilance: true })).toBeCloseTo(0.42);
    expect(stepDelayMs("soft", "L1", 0.6)).toBe(3 * MIN);
    expect(stepDelayMs("overtime", "L1", 0.7)).toBe(7 * MIN);
  });

  it("step order and class ranks", () => {
    expect([nextStep(null), nextStep("L0"), nextStep("L1"), nextStep("L2"), nextStep("L3")]).toEqual(["L0", "L1", "L2", "L3", null]);
    expect(CLASS_RANK.hard).toBeGreaterThan(CLASS_RANK.soft);
    expect(isUpgrade("soft", "hard")).toBe(true);
    expect(isUpgrade("hard", "soft")).toBe(false);
    expect(isUpgrade("overtime", "soft")).toBe(true);
    expect(isUpgrade("hard", "hard")).toBe(false);
  });

  it("L0 copy per trigger (7.6)", () => {
    expect(l0Template("T-OVR", "overtime")).toBe("ot_overtime");
    expect(l0Template("T-DARK", "hard")).toBe("lad_l0_hard");
    expect(l0Template("T-DEP-WALK", "soft")).toBe("lad_l0_soft");
    expect(l0Template("T-NOARRIVE", "soft")).toBe("lad_l0_noarrive");
    expect(l0Template("T-POST-EXIT", "soft")).toBe("lad_l0_post_exit");
  });

  it("high vigilance conditions (7.4)", () => {
    const p = basePlan();
    expect(computeHighVigilance(p)).toBe(false);
    expect(computeHighVigilance({ ...p, type: "marketplace", privateAddress: true })).toBe(true);
    expect(computeHighVigilance({ ...p, type: "date", privateAddress: true })).toBe(false);
    expect(computeHighVigilance({ ...p, transport: "their_car" })).toBe(true);
    expect(computeHighVigilance({ ...p, userNervous: true })).toBe(true);
  });
});

describe("ladder timings through the engine", () => {
  const sched = (fx: Effect[]) => fx.filter((e): e is Extract<Effect, { kind: "schedule" }> => e.kind === "schedule");

  /** Walk a ladder from L0 and return the minutes between steps. */
  function walk(p0: EnginePlan, startMin: number, opts: { night?: boolean } = {}): number[] {
    const gaps: number[] = [];
    let plan = p0;
    let now = at(startMin);
    const ctx = () => ctxAt(now, opts.night === undefined ? {} : { night: opts.night });
    // Start from L0 via end_grace (overtime) or an existing ladder.
    let r = applyEvent(plan, { type: "timer", job: "end_grace" }, ctx());
    for (let i = 0; i < 3; i++) {
      const job = sched(r.effects).find((e) => e.job.kind === "ladder" || e.job.kind === "overtime_timeout")!.job;
      gaps.push((job.runAt.getTime() - now.getTime()) / MIN);
      now = job.runAt;
      plan = r.plan;
      const ev: EngineEvent = job.payload ? { type: "timer", job: job.kind, payload: job.payload } : { type: "timer", job: job.kind };
      r = applyEvent(plan, ev, ctx());
    }
    expect(r.plan.state).toBe("ESCALATED");
    return gaps;
  }

  const activePlan = basePlan({ state: "ACTIVE", locationMode: "none" });

  it("overtime ladder by day: 10, 5, 3", () => {
    expect(walk(activePlan, 135, { night: false })).toEqual([10, 5, 3]);
  });

  it("overtime ladder at night: x0.7", () => {
    expect(walk(activePlan, 135, { night: true })).toEqual([7, 3.5, 2.1]);
  });

  it("night is detected from the user's timezone when not overridden", () => {
    // 2026-10-11 03:00 UTC is 23:00 in New York.
    const p = basePlan({ state: "ACTIVE", locationMode: "none", startAt: new Date("2026-10-11T00:45:00Z"), endAt: new Date("2026-10-11T02:45:00Z") });
    const r = applyEvent(p, { type: "timer", job: "end_grace" }, ctxAt(new Date("2026-10-11T03:00:00Z")));
    const job = sched(r.effects).find((e) => e.job.kind === "overtime_timeout")!.job;
    expect((job.runAt.getTime() - new Date("2026-10-11T03:00:00Z").getTime()) / MIN).toBe(7);
  });

  it("high vigilance overtime ladder: x0.6", () => {
    expect(walk({ ...activePlan, highVigilance: true }, 135, { night: false })).toEqual([6, 3, 1.8]);
  });

  it("night and high vigilance: x0.42", () => {
    const g = walk({ ...activePlan, highVigilance: true }, 135, { night: true });
    expect(g.map((x) => Math.round(x * 100) / 100)).toEqual([4.2, 2.1, 1.26]);
  });
});

describe("I7: no LLM or NLU in the escalation path", () => {
  it("plan/, risk/, scheduler/ never import nlu, dialogue, or LLM SDKs", () => {
    const root = join(import.meta.dirname, "../../../apps/server/src");
    for (const dir of ["plan", "risk", "scheduler"]) {
      for (const file of readdirSync(join(root, dir))) {
        if (!file.endsWith(".ts")) continue;
        const src = readFileSync(join(root, dir, file), "utf8");
        const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
        for (const imp of imports) {
          expect(imp, `${dir}/${file}`).not.toMatch(/nlu|dialogue|anthropic|openai|llm|notify\//i);
        }
      }
    }
  });

  it("the only reply input is a precomputed label", () => {
    // Free text cannot reach the engine: user_reply carries a ReplyLabel, not text.
    const r = applyEvent(
      basePlan({ state: "CHECKING", shareConfirmedAt: at(-25), ladderStep: "L1", ladderClass: "soft", ladderTrigger: "T-DEP-WALK", ladderStartedAt: at(30), ladderStepAt: at(35) }),
      { type: "user_reply", label: "AMBIGUOUS", messageId: "m" },
      ctxAt(at(36)),
    );
    expect(r.plan.state).toBe("CHECKING");
  });
});
