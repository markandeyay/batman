// Required simulation scenarios (spec 15.3) at engine level: FakeClock, replay tracks, real
// store + scheduler + PlanRuntime, recorded outbound effects. Times are minutes from start.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Fix } from "../../apps/server/src/contracts.js";
import { filterByExactAddress } from "../../apps/server/src/location/source.js";
import { destinationPoint } from "../../apps/server/src/risk/geometry.js";
import { GUARDIAN, START, STRANGER, Sim, USER, type SimOptions } from "./harness.js";

const sims: Sim[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of sims.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function sim(opts: SimOptions): Promise<Sim> {
  const s = await Sim.create(opts);
  sims.push(s);
  return s;
}

const date = { firstTimeInPerson: false } as const;
const LADDER_TEMPLATES = /^user:(lad_|ot_|act_mid_check|act_new_spot)/;

describe("15.3 scenarios", () => {
  it("S-01: date, arrive, leave on time, home -> arrival line, no check-ins, closure, guardian hears nothing", async () => {
    const s = await sim({ track: "date-normal", plan: date });
    await s.runUntil(24 * 60);
    expect(s.timeline(-1000)).toEqual([
      "-120 send user:plan_locked_in",
      "-30 send user:loc_request_intro",
      "1 send user:act_arrival",
      "130 send user:close_glad_back",
    ]);
    expect(s.sends().filter((x) => LADDER_TEMPLATES.test(x))).toEqual([]);
    expect(s.guardianSends()).toEqual([]);
    expect(s.transitions()).toEqual(["DRAFT->ARMED", "ARMED->PRE_MEETUP", "PRE_MEETUP->ACTIVE", "ACTIVE->CLOSED"]);
    expect(s.out.filter((o) => o.kind === "stop_watch").map((o) => o.t)).toEqual([130]);
    expect(s.errors).toEqual([]);
  });

  it("S-01 / I12: fixes are purged 24 h after close", async () => {
    const s = await sim({ track: "date-normal", plan: date });
    await s.runUntil(140);
    expect(s.storedFixes().length).toBeGreaterThan(100);
    await s.runUntil(130 + 24 * 60 - 1);
    expect(s.storedFixes().length).toBeGreaterThan(100);
    await s.runUntil(130 + 24 * 60);
    expect(s.storedFixes()).toEqual([]);
  });

  it("S-02: date runs 40 min over, +30 -> overtime msg, extension confirmed, no guardian contact", async () => {
    const s = await sim({ track: "date-overtime", plan: date });
    await s.runUntil(200);
    expect(s.timeline(1)).toEqual(["135 send user:ot_overtime", "138 send user:act_extend_confirm", "175 send user:close_glad_back"]);
    const confirm = s.out.find((o) => o.template === "act_extend_confirm")!;
    expect(confirm.params?.endAt).toEqual(new Date(START.getTime() + 168 * 60_000));
    expect(s.guardianSends()).toEqual([]);
    expect(s.transitions()).toEqual(["DRAFT->ARMED", "ARMED->PRE_MEETUP", "PRE_MEETUP->ACTIVE", "ACTIVE->OVERTIME", "OVERTIME->ACTIVE", "ACTIVE->CLOSED"]);
  });

  it("S-03: overtime, no reply -> L1 at T1, L2 call, L3 guardian text + call, repeats every 3 min until GOT IT", async () => {
    const s = await sim({ track: "date-overtime", plan: date, script: [{ t: 160, event: { type: "guardian_ack" } }] });
    await s.runUntil(171);
    expect(s.timeline(1)).toEqual([
      "135 send user:ot_overtime",
      "145 send user:lad_l1",
      "150 call user:checkin",
      "150 send user:lad_l2_text",
      "153 send guardian:gdn_alert",
      "153 call guardian:guardian_alert",
      "156 send guardian:gdn_alert_repeat",
      "159 send guardian:gdn_alert_repeat",
      "165 send guardian:gdn_location_update",
      "170 send guardian:gdn_location_update",
    ]);
    const alert = s.out.find((o) => o.template === "gdn_alert")!;
    expect(alert).toMatchObject({ critical: true, notifyAnyway: true });
    // I11: the alert states what is known (time silent, last fix age), never certainty.
    expect(alert.params).toMatchObject({ reason: { kind: "no_reply", trigger: "T-OVR" }, trigger: "T-OVR", minutesSilent: 18, userName: "Alex", venueText: "Lula Cafe" });
    // The fix is current (0 min old) at alert time.
    const ap = alert.params as { fix: { at: Date }; now: Date };
    expect(ap.fix.at.getTime()).toBe(ap.now.getTime());
    expect(s.out.filter((o) => o.template === "lad_l1" || o.template === "lad_l2_text").every((o) => o.notifyAnyway)).toBe(true);
    // 6.4: no user messages after L3.
    expect(s.sends(153).filter((x) => x.startsWith("user:"))).toEqual([]);
    expect(s.plan().state).toBe("ESCALATED");
  });

  it("S-03 without GOT IT: exactly 5 repeats, then silence", async () => {
    const s = await sim({ track: "date-overtime", plan: date, script: [] });
    await s.runUntil(240);
    expect(s.out.filter((o) => o.template === "gdn_alert_repeat").map((o) => o.t)).toEqual([156, 159, 162, 165, 168]);
    expect(s.guardianSends().every((o) => o.critical)).toBe(true);
  });

  it("S-04: overtime, user replies yeah lol at L1 -> resolved, tapback, no guardian contact", async () => {
    // Texts "home" before driving off at 160 (a silent car departure before the extended end would be T-DEP-CAR).
    const s = await sim({ track: "date-overtime", plan: date, script: [{ t: 146, text: "yeah lol", label: "OK" }, { t: 158, text: "home" }] });
    await s.runUntil(200);
    expect(s.timeline(1)).toEqual(["135 send user:ot_overtime", "145 send user:lad_l1", "146 react", "146 send user:act_extend_confirm", "158 send user:close_glad_back"]);
    expect(s.guardianSends()).toEqual([]);
    expect(s.out.some((o) => o.kind === "call")).toBe(false);
  });

  it("S-05: overtime, not really -> NOT_OK -> L3 immediately + exit call", async () => {
    const s = await sim({ track: "date-overtime", plan: date, script: [{ t: 140, text: "not really", label: "NOT_OK" }] });
    await s.runUntil(141);
    expect(s.timeline(1)).toEqual([
      "135 send user:ot_overtime",
      "140 send user:act_calling_you_now",
      "140 call user:fake",
      "140 send guardian:gdn_alert",
      "140 call guardian:guardian_alert",
    ]);
    expect(s.out.find((o) => o.template === "gdn_alert")!.params?.reason).toEqual({ kind: "not_ok_reply" });
  });

  it("S-05 with calls down: the exit call falls back to a text (6.6 step 3)", async () => {
    const s = await sim({ track: "date-overtime", plan: date, callsWork: false, script: [{ t: 140, text: "not really", label: "NOT_OK" }] });
    await s.runUntil(141);
    expect(s.timeline(139)).toEqual([
      "140 send user:act_calling_you_now",
      "140 call user:fake",
      "140 send user:cw_call_fallback_text",
      "140 send guardian:gdn_alert",
      "140 call guardian:guardian_alert",
    ]);
  });

  it("S-06: restart during L1 -> L2 fires at the correct time, no duplicate L1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batman-s06-"));
    dirs.push(dir);
    const s = await sim({ track: "date-overtime", plan: date, script: [], dbPath: join(dir, "batman.db") });
    await s.runUntil(147);
    expect(s.timeline(140)).toEqual(["145 send user:lad_l1"]);
    await s.restart();
    await s.runUntil(149.9);
    expect(s.timeline(146)).toEqual([]);
    await s.runUntil(151);
    expect(s.timeline(146)).toEqual(["150 call user:checkin", "150 send user:lad_l2_text"]);
    expect(s.sends().filter((x) => x === "user:lad_l1")).toHaveLength(1);
  });

  it("S-07: marketplace at a public spot, done in 15 min -> no triggers, closure", async () => {
    const s = await sim({ track: "marketplace-public", plan: { type: "marketplace", durationMin: 20 } });
    await s.runUntil(90);
    expect(s.timeline(-1000)).toEqual(["-120 send user:plan_locked_in", "-30 send user:loc_request_intro", "0 send user:act_arrival", "15 send user:close_done_ack"]);
    expect(s.plan().state).toBe("CLOSED");
    expect(s.guardianSends()).toEqual([]);
  });

  it("S-08: marketplace at a private address, vehicle departure 8 min in -> high vigilance, T-DEP-CAR, 0.6x timers", async () => {
    const s = await sim({ track: "marketplace-private-car-departure", plan: { type: "marketplace", durationMin: 20, privateAddress: true } });
    await s.runUntil(20);
    expect(s.plan().highVigilance).toBe(true);
    expect(s.timeline(1)).toEqual([
      "10 send user:lad_l0_hard",
      "11.8 send user:lad_l1", // hard T1 3 min x 0.6
      "13 call user:checkin", // T2 2 min x 0.6
      "13 send user:lad_l2_text",
      "14.2 send guardian:gdn_alert", // T3 2 min x 0.6
      "14.2 call guardian:guardian_alert",
      "17.2 send guardian:gdn_alert_repeat",
    ]);
    expect(s.out.find((o) => o.template === "gdn_alert")!.params).toMatchObject({ reason: { kind: "no_reply", trigger: "T-DEP-CAR" }, trigger: "T-DEP-CAR" });
  });

  it("S-09: date, walk to a bar 400 m away, stay 30 min -> New spot only, no ladder when answered", async () => {
    const s = await sim({ track: "date-walk-to-bar", plan: date });
    await s.runUntil(140);
    expect(s.timeline(1)).toEqual(["54 send user:act_new_spot", "58 react", "130 send user:close_glad_back"]);
    expect(s.sends().filter((x) => /:lad_/.test(x))).toEqual([]);
    expect(s.guardianSends()).toEqual([]);
  });

  it("S-09 unanswered: New spot becomes a soft check after 15 min", async () => {
    const s = await sim({ track: "date-walk-to-bar", plan: date, script: [] });
    await s.runUntil(70);
    expect(s.timeline(1)).toEqual(["54 send user:act_new_spot", "69 send user:lad_l0_soft"]);
  });

  it("S-10: location dark 12 min mid-date -> T-DARK ladder; phone died lol resolves it", async () => {
    const s = await sim({ track: "date-dark", plan: date });
    await s.runUntil(140);
    expect(s.timeline(1)).toEqual(["60 send user:lad_l0_hard", "62.5 react", "125 send user:close_glad_back"]);
    expect(s.transitions()).toContain("ACTIVE->CHECKING");
    expect(s.transitions()).toContain("CHECKING->ACTIVE");
    expect(s.guardianSends()).toEqual([]);
  });

  it("S-11: viewing with indoor GPS drift up to 180 m -> no false departure", async () => {
    const s = await sim({ track: "viewing-indoor-drift", plan: { type: "viewing", durationMin: 45 } });
    await s.runUntil(60);
    expect(s.timeline(1)).toEqual(["40 send user:close_done_ack"]);
    expect(s.sends().filter((x) => LADDER_TEMPLATES.test(x))).toEqual([]);
  });

  it("S-17: no Find My share -> time-only, overtime works, no location triggers", async () => {
    const s = await sim({ track: "no-share", plan: date });
    await s.runUntil(170);
    expect(s.timeline(-1000)).toEqual([
      "-120 send user:plan_locked_in",
      "-30 send user:loc_request_intro",
      "-15 send user:loc_reminder",
      "0 send user:loc_time_only",
      "0 send user:act_arrival",
      "135 send user:ot_overtime",
      "140 send user:act_extend_confirm",
      "160 send user:close_glad_back",
    ]);
    expect(s.plan().locationMode).toBe("none");
    expect(s.out.some((o) => o.kind === "start_watch")).toBe(false);
  });

  it("S-17 time-only with no reply: overtime ladder still escalates", async () => {
    const s = await sim({ track: "no-share", plan: date, script: [] });
    await s.runUntil(154);
    expect(s.timeline(100)).toEqual([
      "135 send user:ot_overtime",
      "145 send user:lad_l1",
      "150 call user:checkin",
      "150 send user:lad_l2_text",
      "153 send guardian:gdn_alert",
      "153 call guardian:guardian_alert",
    ]);
    expect(s.out.find((o) => o.template === "gdn_alert")!.params?.fix).toBeNull();
  });

  it("S-21: list() returns another person's location -> ignored (I2)", async () => {
    const s = await sim({ track: "date-normal", plan: date });
    await s.runUntil(60);
    const before = s.storedFixes().length;
    // A list() result with the user's fix and a stranger 8 km away (which would be T-FAR).
    const far = destinationPoint(41.9172, -87.7067, 8000, 0);
    const now = s.clock.now();
    const entries: { address: string; fix: Fix }[] = [
      { address: STRANGER, fix: { lat: far.lat, lng: far.lng, accuracyM: 10, at: now, locationType: "live", expiresAt: null, source: "findmy" } },
      { address: USER, fix: { lat: 41.9172, lng: -87.7067, accuracyM: 10, at: now, locationType: "live", expiresAt: null, source: "findmy" } },
      { address: GUARDIAN, fix: { lat: far.lat, lng: far.lng, accuracyM: 10, at: now, locationType: "live", expiresAt: null, source: "findmy" } },
    ];
    for (const e of filterByExactAddress(entries, USER)) await s.runtime.ingestFix(s.planId, e.fix);
    await s.runUntil(70);
    const stored = s.storedFixes();
    expect(stored.length).toBe(before + 1 + 10);
    expect(stored.some((f) => Math.abs(f.lat - far.lat) < 1e-6)).toBe(false);
    expect(s.sends().filter((x) => LADDER_TEMPLATES.test(x))).toEqual([]);
  });

  it("I3: fixes outside a window are discarded, not stored", async () => {
    const s = await sim({ track: "date-normal", plan: date });
    const f: Fix = { lat: 41.9, lng: -87.7, accuracyM: 10, at: s.clock.now(), locationType: "live", expiresAt: null, source: "findmy" };
    expect(await s.runtime.ingestFix(s.planId, f)).toBe(false); // ARMED
    expect(s.storedFixes()).toEqual([]);
    await s.runUntil(140); // CLOSED
    const n = s.storedFixes().length;
    expect(await s.runtime.ingestFix(s.planId, { ...f, at: s.clock.now() })).toBe(false);
    expect(s.storedFixes()).toHaveLength(n);
  });

  it("S-25: host asleep 20 min during ACTIVE -> overdue jobs run once, in order, ladder continues, no duplicates", async () => {
    const s = await sim({ track: "no-share", plan: { firstTimeInPerson: true }, script: [] });
    // Asleep from 40 to 60 (mid-check at 54 is missed) and from 130 to 150 (overtime at 135 is missed).
    await s.sleepHost(40, 60);
    expect(s.timeline(1)).toEqual(["60 send user:act_mid_check"]);
    await s.sleepHost(130, 150);
    expect(s.timeline(100)).toEqual(["150 send user:ot_overtime"]);
    await s.runUntil(170);
    expect(s.timeline(100)).toEqual([
      "150 send user:ot_overtime",
      "160 send user:lad_l1",
      "165 call user:checkin",
      "165 send user:lad_l2_text",
      "168 send guardian:gdn_alert",
      "168 call guardian:guardian_alert",
    ]);
    const counts = new Map<string, number>();
    for (const x of s.sends()) counts.set(x, (counts.get(x) ?? 0) + 1);
    for (const t of ["user:act_mid_check", "user:ot_overtime", "user:lad_l1", "user:lad_l2_text", "guardian:gdn_alert"]) expect(counts.get(t), t).toBe(1);
  });

  it("I16: an internal error during an active plan sends a plain check-in", async () => {
    const s = await sim({ track: "date-normal", plan: date });
    await s.runUntil(30);
    await s.send({ type: "internal_error", message: "classifier exploded" });
    expect(s.timeline(29)).toEqual(["30 send user:plain_checkin_error"]);
  });
});
