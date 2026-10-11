// I6. Never contact emergency services: no 911 calls, no texts to emergency numbers. Alert copy
// tells the guardian to call 911 if they believe there is danger.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEMPLATE_IDS, type EscalationReason } from "../../apps/server/src/contracts.js";
import { GUARDIAN_TEMPLATES, renderAllVariants } from "../../apps/server/src/notify/templates.js";
import { normalizePhone } from "../../apps/server/src/util/phone.js";
import { DATE_EXTRACTION, FullStack } from "../sim/fullstack.js";

const sims: FullStack[] = [];
afterEach(() => sims.splice(0).forEach((s) => s.close()));

const EMERGENCY = ["911", "112", "999", "000", "+1911", "1-911"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("I6 never contact emergency services", () => {
  it("emergency numbers never normalize to a sendable address", () => {
    for (const n of EMERGENCY) expect(normalizePhone(n), n).toBeNull();
  });

  it.each([["Mom 911"], ["911"], ["call 112 please"]])("a guardian named with %s is rejected at onboarding", async (text) => {
    const s = new FullStack();
    sims.push(s);
    await s.text("user", "hi");
    await s.text("user", "Alex");
    await s.text("user", text);
    expect(s.sent.at(-1)!.template).toBe("onb_guardian_invalid");
    expect(s.registered).toEqual([]);
  });

  it("every guardian alert tells the guardian to call 911 themselves", () => {
    const reasons: EscalationReason[] = [
      { kind: "no_reply", trigger: "T-OVR", minutesSilent: 18 },
      { kind: "alert_word" },
      { kind: "distress" },
      { kind: "not_ok_reply" },
    ];
    for (const reason of reasons) for (const t of renderAllVariants("gdn_alert", { userName: "Alex", reason })) expect(t).toContain("call 911");
  });

  it("no user-facing template offers to call 911 for the user", () => {
    for (const id of TEMPLATE_IDS.filter((i) => !GUARDIAN_TEMPLATES.includes(i))) {
      for (const t of renderAllVariants(id, { userName: "Alex" })) expect(t, id).not.toMatch(/I('ll| will) call 911|calling 911/i);
    }
  });

  it("no product source dials or texts an emergency number literal", () => {
    const root = join(import.meta.dirname, "../../apps/server/src");
    // notify/ holds copy ("call 911" for the guardian) and the I10 banned-word list ("911").
    for (const f of sourceFiles(root).filter((p) => !/[\\/]notify[\\/]/.test(p))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/["'`](\+?1?[-\s]?)?(911|112|999)["'`]/);
      expect(src, f).not.toMatch(/tel:\+?(911|112|999)/);
    }
  });

  it("full stack: an escalation calls and texts only the user and the guardian", async () => {
    const s = new FullStack({ track: "date-overtime", trackMessages: false, llm: { extract: [{ match: "jordan", out: DATE_EXTRACTION }] } });
    sims.push(s);
    await s.onboard();
    await s.planDate();
    s.at(140, "user", "he won't let me leave");
    await s.runUntil(200);
    const addresses = new Set([...s.sent.map((m) => m.address), ...s.calls.attempts.map((c) => c.to)]);
    expect([...addresses].sort()).toEqual(["+13125550100", "+19195550142"]);
  });
});
