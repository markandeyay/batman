// I16. Fail toward the user: an internal error during an active plan sends the user a plain
// check-in and is logged. If the scheduler or Photon stream is down at a scheduled escalation
// time, the escalation runs as soon as the service recovers (durable timers).
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATE_EXTRACTION, FullStack } from "../sim/fullstack.js";
import { Sim } from "../sim/harness.js";

// Fault injection: the real engine, except that one magic reply id makes applyEvent throw.
vi.mock("../../apps/server/src/plan/stateMachine.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../apps/server/src/plan/stateMachine.js")>();
  return {
    ...real,
    applyEvent: (plan: Parameters<typeof real.applyEvent>[0], event: Parameters<typeof real.applyEvent>[1], ctx: Parameters<typeof real.applyEvent>[2]) => {
      if (event.type === "user_reply" && event.messageId === "boom") throw new Error("engine bug (injected)");
      return real.applyEvent(plan, event, ctx);
    },
  };
});

const sims: { close(): void }[] = [];
afterEach(() => sims.splice(0).forEach((s) => s.close()));

describe("I16 fail toward the user", () => {
  it("an engine exception during an active plan sends a plain check-in and is reported", async () => {
    const s = await Sim.create({ track: "date-normal", plan: { firstTimeInPerson: false } });
    sims.push(s);
    await s.runUntil(30);
    await expect(s.runtime.dispatch(s.planId, { type: "user_reply", label: "OK", messageId: "boom" })).rejects.toThrow("injected");
    expect(s.timeline(29)).toEqual(["30 send user:plain_checkin_error"]);
    expect(s.errors.map((e) => String(e))).toEqual(["Error: engine bug (injected)"]);
    expect(s.plan().state).toBe("ACTIVE"); // the failed event changed nothing
  });

  it("a failed send does not stop the rest of the ladder; the guardian is still alerted on time", async () => {
    const s = new FullStack({ track: "date-overtime", trackMessages: false, llm: { extract: [{ match: "jordan", out: DATE_EXTRACTION }] } });
    sims.push(s);
    await s.onboard();
    await s.planDate();
    const real = s.channel.sendText.bind(s.channel);
    s.channel.sendText = async (to, text) => {
      if (text.startsWith("Text me back when you can")) throw new Error("Photon send failed (injected)");
      return real(to, text);
    };
    await s.runUntil(154);
    expect(s.timeline(100)).toEqual([
      "135 send user:ot_overtime",
      "150 send user:lad_l2_text",
      "150 call user:checkin",
      "153 send guardian:gdn_alert",
      "153 call guardian:guardian_alert",
    ]);
    expect(s.errors.map((e) => String(e))).toEqual(["Error: Photon send failed (injected)"]);
  });

  it("host asleep through L1 and L2: on wake, overdue steps run once, in order (durable timers)", async () => {
    const s = await Sim.create({ track: "date-overtime", plan: { firstTimeInPerson: false }, script: [] });
    sims.push(s);
    await s.sleepHost(140, 152);
    expect(s.timeline(140)).toEqual(["152 send user:lad_l1"]);
    await s.runUntil(170);
    // The ladder continues from where it was, with no duplicates.
    const counts = new Map<string, number>();
    for (const x of s.sends(140)) counts.set(x, (counts.get(x) ?? 0) + 1);
    expect(counts.get("user:lad_l1")).toBe(1);
    expect(counts.get("guardian:gdn_alert")).toBe(1);
    expect(s.plan().state).toBe("ESCALATED");
  });
});
