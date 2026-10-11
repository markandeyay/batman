// I5. Ask the user first: except for the alert word and explicit distress, Batman always
// contacts the user before contacting the guardian.
import { afterEach, describe, expect, it } from "vitest";
import { Sim, type SimOptions } from "../sim/harness.js";

const sims: Sim[] = [];
afterEach(() => sims.splice(0).forEach((s) => s.close()));

const noReply: [string, SimOptions][] = [
  ["overtime (T-OVR)", { track: "date-overtime", plan: { firstTimeInPerson: false }, script: [] }],
  ["location dark (T-DARK)", { track: "date-dark", plan: { firstTimeInPerson: false }, script: [] }],
  ["vehicle departure, high vigilance (T-DEP-CAR)", { track: "marketplace-private-car-departure", plan: { type: "marketplace", durationMin: 20, privateAddress: true } }],
  ["new spot unanswered (T-VENUE-CHG)", { track: "date-walk-to-bar", plan: { firstTimeInPerson: false }, script: [] }],
  ["time-only overtime", { track: "no-share", plan: { firstTimeInPerson: false }, script: [] }],
];

describe("I5 ask the user first", () => {
  it.each(noReply)("%s: L0, L1, and the L2 call reach the user before any guardian message", async (_n, opts) => {
    const s = await Sim.create(opts);
    sims.push(s);
    await s.runUntil(300);
    const firstGuardian = s.out.findIndex((o) => o.kind === "send" && o.to === "guardian");
    expect(firstGuardian, "the scenario escalates").toBeGreaterThan(-1);
    const before = s.out.slice(0, firstGuardian);
    const userLadder = before.filter((o) => o.kind === "send" && o.to === "user" && /^(lad_|ot_)/.test(o.template ?? ""));
    expect(userLadder.length).toBeGreaterThanOrEqual(2);
    expect(before.some((o) => o.kind === "call" && o.to === "user" && o.script === "checkin")).toBe(true);
    expect(s.out[firstGuardian]!.template).toBe("gdn_alert");
  });

  it.each([
    ["alert word", { type: "alert_word", messageId: "m1" }],
    ["explicit distress", { type: "distress", messageId: "m1" }],
  ] as const)("%s is the exception: the guardian is alerted at once", async (_n, event) => {
    const s = await Sim.create({ track: "date-normal", plan: { firstTimeInPerson: false }, script: [{ t: 60, event }] });
    sims.push(s);
    await s.runUntil(61);
    expect(s.sends(59)).toContain("guardian:gdn_alert");
    expect(s.sends(59).filter((x) => /^user:(lad_|ot_)/.test(x))).toEqual([]);
  });
});
