// Spec 15.3 scenarios end to end: user and guardian texts go into the real dialogue manager,
// the real engine decides, and the recorded outbound sends (recipient, template id, text, order)
// are asserted. Times are minutes from START (Sat 7:00 PM New York). Onboarding and intake run
// at -240 through the dialogue, so every scenario also exercises 4.2, 4.3, and 4.4.
import { afterEach, describe, expect, it } from "vitest";
import { findBannedWords, isDiscreet } from "../../apps/server/src/notify/discretion.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { DATE_EXTRACTION, FullStack, GUARDIAN, QuotaPolicy, START, STRANGER, USER, type FullStackOptions, type LlmScript } from "./fullstack.js";

const sims: FullStack[] = [];
afterEach(() => {
  for (const s of sims.splice(0)) {
    try {
      checkGlobalInvariants(s);
    } finally {
      s.close();
    }
  }
});

/** Checks every scenario must pass, whatever it tests. */
function checkGlobalInvariants(s: FullStack): void {
  expect(s.errors, "no internal errors").toEqual([]);
  // I10: everything sent to the user in a discreet state reads like a friend's text.
  for (const m of s.discreetSends()) expect(findBannedWords(m.text), `${m.template} in ${m.state}: ${m.text}`).toEqual([]);
  // I14: nothing reaches an address after the stop_ack sent to it.
  for (const stop of s.sent.filter((m) => m.template === "stop_ack")) {
    expect(s.sent.filter((m) => m.address === stop.address && m.seq > stop.seq).map((m) => m.template)).toEqual([]);
  }
  // I6: no message or call ever goes to an emergency number.
  for (const a of [...s.sent.map((m) => m.address), ...s.callLog.map((c) => c.address)]) expect(a).not.toMatch(/^\+?(1)?(911|112|999)$/);
}

const llmScript = (extra: Partial<LlmScript> = {}): LlmScript => ({
  extract: [{ match: "jordan", out: DATE_EXTRACTION }],
  classify: [],
  ...extra,
});

async function dateSim(opts: FullStackOptions = {}, onboard: { guardianAccepts?: boolean } = {}): Promise<FullStack> {
  const s = new FullStack({ llm: llmScript(), ...opts });
  sims.push(s);
  await s.onboard(onboard);
  await s.planDate();
  return s;
}

const LADDER = /^user:(lad_|ot_|act_mid_check|act_new_spot)/;
const MIN = 60_000;

describe("15.3 full stack: onboarding and intake through the dialogue", () => {
  it("onboarding, guardian opt-in (shared pool: guardian texts first), intake, GO, arming", async () => {
    const s = await dateSim({ track: "date-normal" });
    expect(s.sends()).toEqual([
      "user:onb_hello",
      "user:onb_ask_name",
      "user:onb_ask_guardian",
      "user:onb_guardian_text_first",
      "user:onb_ask_codewords",
      "guardian:gdn_optin_request",
      "guardian:gdn_optin_thanks",
      "user:usr_guardian_in",
      "user:onb_save_contact",
      "user:onb_disclosure_done",
      "user:plan_confirm",
      "user:plan_locked_in",
    ]);
    // I1: the opt-in request names the user only; no plan details before YES.
    const optin = s.sent.find((m) => m.template === "gdn_optin_request")!;
    expect(optin.text).not.toMatch(/Lula|Jordan|7:00|date/i);
    expect(s.registered).toEqual([GUARDIAN]);
    expect(s.sent.find((m) => m.template === "plan_confirm")!.text).toContain("Date with Jordan (Hinge), Sat 7:00 PM at Lula Cafe");
    expect(s.sent.find((m) => m.template === "plan_locked_in")!.text).toBe("Locked in. Around 6:30 PM I'll ask you to share your location until it's over.");
    // GO got a tapback, and only GO armed the plan (I1).
    const go = s.inboundLog.at(-1)!;
    expect(s.channel.reacts.map((r) => r.messageId)).toEqual([go.id]);
    expect(s.transitions()).toEqual(["DRAFT->ARMED"]);
  });
});

describe("15.3 full stack scenarios", () => {
  it("S-01: date, arrive, leave on time, home -> arrival line, no check-ins, closure, guardian hears nothing", async () => {
    const s = await dateSim({ track: "date-normal" });
    const guardianBefore = s.guardianSends().length;
    await s.runUntil(24 * 60 + 200);
    expect(s.timeline(-60)).toEqual(["-30 send user:loc_request_intro", "1 send user:act_arrival", "130 send user:close_glad_back"]);
    expect(s.sent.find((m) => m.template === "close_glad_back")!.text).toContain("Plan closed and your location's no longer shared with me.");
    expect(s.sends().filter((x) => LADDER.test(x))).toEqual([]);
    expect(s.guardianSends().length).toBe(guardianBefore);
    expect(s.callLog).toEqual([]);
    expect(s.transitions()).toEqual(["DRAFT->ARMED", "ARMED->PRE_MEETUP", "PRE_MEETUP->ACTIVE", "ACTIVE->CLOSED"]);
    expect(s.routes.at(-1)).toMatchObject({ t: 130, route: "cmd_home" });
    // I12: raw fixes are gone 24 h after close.
    expect(repo.listFixes(s.store, s.plan()!.id)).toEqual([]);
  });

  it("S-02: overtime, user texts +30 -> extension confirmed, no guardian contact", async () => {
    const s = await dateSim({ track: "date-overtime" });
    await s.runUntil(200);
    expect(s.timeline(1)).toEqual(["135 send user:ot_overtime", "138 send user:act_extend_confirm", "175 send user:close_glad_back"]);
    expect(s.sent.find((m) => m.template === "act_extend_confirm")!.text).toBe("Got it, back by about 9:48 PM then.");
    expect(s.guardianSends().filter((m) => m.t > -100)).toEqual([]);
  });

  it("S-03: overtime, no reply -> L1, L2 call, L3 guardian text + call, repeats every 3 min until GOT IT", async () => {
    const s = await dateSim({ track: "date-overtime", trackMessages: false });
    s.at(160, "guardian", "got it");
    await s.runUntil(175);
    expect(s.timeline(1)).toEqual([
      "135 send user:ot_overtime",
      "145 send user:lad_l1",
      "150 send user:lad_l2_text",
      "150 call user:checkin",
      "153 send guardian:gdn_alert",
      "153 call guardian:guardian_alert",
      "156 send guardian:gdn_alert_repeat",
      "159 send guardian:gdn_alert_repeat",
      "165 send guardian:gdn_location_update",
      "170 send guardian:gdn_location_update",
    ]);
    expect(s.routes.find((r) => r.t === 160)!.route).toBe("guardian_ack");
    const alert = s.sent.find((m) => m.template === "gdn_alert")!;
    expect(alert).toMatchObject({ critical: true, notifyAnyway: true, address: GUARDIAN });
    expect(alert.text.split("\n")).toEqual([
      "⚠️ Alex might need help.",
      "Alex hasn't answered my last 3 messages or a call (18 min) during a date with Jordan (Hinge).",
      expect.stringMatching(/^Last location at 9:33 PM \(just now, ±20 m\)$/),
      expect.stringMatching(/^https:\/\/maps\.apple\.com\/\?ll=41\.91\d\d,-87\.70\d\d&q=Alex$/),
      "Plan: Lula Cafe, 7:00 to 9:00 PM. Alex is driving themselves.",
      "Please call Alex now. If you think they're in danger, call 911.",
      "Reply GOT IT so I know you're on it.",
    ]);
    // Notify Anyway on L1, L2, and every guardian alert (6.4, 5.3).
    expect(s.channel.notified.length).toBe(s.sent.filter((m) => m.notifyAnyway).length);
    expect(s.sent.filter((m) => m.template === "lad_l1" || m.template === "lad_l2_text").every((m) => m.notifyAnyway)).toBe(true);
    // 6.4: no user messages after L3.
    expect(s.sends(153, "user")).toEqual([]);
    expect(s.plan()!.state).toBe("ESCALATED");
  });

  it("S-04: overtime, yeah lol at L1 -> resolved with a tapback, no guardian contact", async () => {
    const s = await dateSim({ track: "date-overtime", trackMessages: false });
    s.at(146, "user", "yeah lol").at(158, "user", "home");
    await s.runUntil(200);
    expect(s.timeline(1)).toEqual(["135 send user:ot_overtime", "145 send user:lad_l1", "146 send user:act_extend_confirm", "158 send user:close_glad_back"]);
    expect(s.channel.reacts.at(-1)!.messageId).toBe(s.inboundLog.find((m) => m.t === 146)!.id);
    expect(s.guardianSends().filter((m) => m.t > -100)).toEqual([]);
  });

  it("S-05: overtime, not really -> NOT_OK -> L3 immediately + exit call", async () => {
    const s = await dateSim({ track: "date-overtime", trackMessages: false });
    s.at(140, "user", "not really");
    await s.runUntil(141);
    expect(s.timeline(1)).toEqual([
      "135 send user:ot_overtime",
      "140 send user:act_calling_you_now",
      "140 send guardian:gdn_alert",
      "140 call user:fake",
      "140 call guardian:guardian_alert",
    ]);
    expect(s.routes.at(-1)!.route).toBe("reply_not_ok");
    expect(s.sent.find((m) => m.template === "gdn_alert")!.text).toContain(
      "Alex replied to my message in a way that sounded like they're not okay during a date with Jordan (Hinge).",
    );
    expect(s.sent.find((m) => m.template === "act_calling_you_now")!.text).toBe("Calling you now.");
  });

  it("S-12: exit word mid-date -> innocuous reply < 2 s, call placed < 20 s, post-exit watch", async () => {
    const s = await dateSim({ track: "date-normal" });
    s.at(60, "user", "lol pineapple");
    await s.runUntil(71);
    expect(s.timeline(59)).toEqual(["60 send user:cw_exit_reply", "60 call user:fake", "70 send user:lad_l0_post_exit"]);
    const inAt = s.inboundLog.find((m) => m.t === 60)!.at.getTime();
    const reply = s.sent.find((m) => m.template === "cw_exit_reply")!;
    expect(reply.at.getTime() - inAt).toBeLessThan(2000);
    expect(["lol ok", "haha true", "omg ok one sec"]).toContain(reply.text);
    expect(s.callLog[0]!.at.getTime() - inAt).toBeLessThan(20_000);
    expect(s.calls.attempts[0]).toMatchObject({ to: USER, script: "fake", decoy: "roommate" });
    // Post-exit watch: still at the venue after 10 min -> "Did you get out okay?"
    expect(s.sent.find((m) => m.template === "lad_l0_post_exit")!.text).toBe("Did you get out okay?");
    expect(s.guardianSends().filter((m) => m.t > -100)).toEqual([]);
  });

  it("S-13: alert word -> innocuous reply, guardian text + call < 15 s, no user-facing hint", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    s.at(60, "user", "blue moon");
    await s.runUntil(75);
    const inAt = s.inboundLog.find((m) => m.t === 60)!.at.getTime();
    expect(s.timeline(59).slice(0, 3)).toEqual(["60 send user:cw_alert_reply", "60 send guardian:gdn_alert", "60 call guardian:guardian_alert"]);
    const reply = s.sent.find((m) => m.template === "cw_alert_reply")!;
    expect(reply.text).toBe("haha ok");
    const alert = s.sent.find((m) => m.template === "gdn_alert")!;
    expect(alert.at.getTime() - inAt).toBeLessThan(15_000);
    expect(s.callLog.find((c) => c.script === "guardian_alert")!.at.getTime() - inAt).toBeLessThan(15_000);
    expect(alert.text).toContain("Alex sent me their private alert word. That means they want help but may not be able to talk.");
    // 6.7 step 3: nothing more to the user about the alert.
    expect(s.sends(60.001, "user")).toEqual([]);
    expect(s.sends(60.001, "guardian")).toEqual(Array(5).fill("guardian:gdn_alert_repeat"));
  });

  it("S-13 de-escalation: user texts home after the alert word -> guardian hears they're home", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    s.at(60, "user", "blue moon").at(64, "guardian", "on it").at(90, "user", "home");
    await s.runUntil(95);
    expect(s.timeline(61)).toEqual([
      "63 send guardian:gdn_alert_repeat",
      // After GOT IT (64): the first update 5 min later sets the baseline; then only moves > 150 m.
      "69 send guardian:gdn_location_update",
      "90 send user:close_glad_back",
      "90 send guardian:gdn_all_clear",
    ]);
    // H2: after an alert the guardian hears what Alex said, not a claim that they are safe.
    expect(s.sent.find((m) => m.template === "gdn_all_clear")!.text).toBe("Alex texted me that they're home. Thanks for being their backup.");
    expect(s.plan()!.state).toBe("CLOSED");
  });

  it("S-14: exit word with one typo (pinapple) is detected", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    s.at(60, "user", "omg pinapple");
    await s.runUntil(61);
    expect(s.routes.at(-1)!.route).toBe("codeword_exit");
    expect(s.timeline(59)).toEqual(["60 send user:cw_exit_reply", "60 call user:fake"]);
  });

  it("S-15: pineapples are gross matches inside a window (documented) and is plain text outside one", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    s.at(60, "user", "pineapples are gross");
    await s.runUntil(61);
    expect(s.routes.at(-1)!.route).toBe("codeword_exit");
    // H3 (I8): before the window (plan ARMED) code words are matched too; the exit word still
    // rings the phone, and the text never reaches intake.
    const t = new FullStack({ llm: llmScript() });
    sims.push(t);
    await t.onboard();
    await t.planDate();
    expect(await t.text("user", "pineapples are gross")).toBe("codeword_exit");
    expect(t.callLog.map((c) => c.script)).toEqual(["fake"]);
  });

  it("S-16: voice note during a check yields voice_unavailable; a transcript with the alert word alerts", async () => {
    const s = await dateSim({ track: "date-dark", trackMessages: false });
    s.at(61, "user", { kind: "voice_unavailable" });
    // A voice transcript (fromVoice) with a phonetic variant of the alert word (9.1).
    s.at(62, "user", { kind: "text", text: "uh huh its a blew moon tonight", fromVoice: true });
    await s.runUntil(63);
    expect(s.timeline(59)).toEqual([
      "60 send user:lad_l0_hard",
      "61 send user:voice_unavailable",
      "61 send user:lad_clarify", // AMBIGUOUS in CHECKING (8.4 step 6)
      "62 send user:cw_alert_reply",
      "62 send guardian:gdn_alert",
      "62 call guardian:guardian_alert",
    ]);
    expect(s.sent.find((m) => m.template === "voice_unavailable")!.text).toBe("Couldn't hear that one, can you text it?");
    expect(s.routes.filter((r) => r.t >= 61).map((r) => r.route)).toEqual(["voice_unavailable", "codeword_alert"]);
  });

  it("S-16: the phonetic pass is for transcripts only (typed blew moon is not the alert word)", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    s.at(60, "user", "uh huh its a blew moon tonight");
    await s.runUntil(61);
    expect(s.routes.at(-1)!.route).not.toBe("codeword_alert");
    expect(s.guardianSends().filter((m) => m.t > -100)).toEqual([]);
  });

  it("S-18: guardian never accepted, user tries to arm -> AWAITING_GUARDIAN, clear message, never armed", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false }, { guardianAccepts: false });
    expect(s.sends().slice(-2)).toEqual(["user:plan_confirm", "user:plan_awaiting_guardian"]);
    expect(s.sent.at(-1)!.text).toContain("Priya hasn't said yes to being your backup yet, so I can't lock this in until they do.");
    await s.runUntil(200);
    expect(s.transitions()).toEqual(["DRAFT->AWAITING_GUARDIAN", "AWAITING_GUARDIAN->EXPIRED"]);
    // No location request, no arrival, no ladder; X4: one line at the start saying it expired.
    expect(s.sends(-239)).toEqual(["user:plan_expired_unarmed"]);
    expect(s.sent.at(-1)!.t).toBe(0);
    // I1: the guardian never texted Batman, so Batman never texted them.
    expect(s.guardianSends()).toEqual([]);
  });

  it("S-18 then the guardian texts and says YES -> plan armed, user told once", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false }, { guardianAccepts: false });
    s.at(-90, "guardian", "hi").at(-89, "guardian", "yes");
    await s.runUntil(5);
    expect(s.timeline(-91)).toEqual([
      "-90 send guardian:gdn_optin_request",
      "-89 send guardian:gdn_optin_thanks",
      "-89 send user:usr_guardian_in",
      "-89 send user:plan_armed_now",
      "-30 send user:loc_request_intro",
      "1 send user:act_arrival",
    ]);
    expect(s.transitions()).toEqual(["DRAFT->AWAITING_GUARDIAN", "AWAITING_GUARDIAN->ARMED", "ARMED->PRE_MEETUP", "PRE_MEETUP->ACTIVE"]);
  });

  it("S-19: guardian texts STOP -> ack, user told once, no further messages to the guardian", async () => {
    const s = await dateSim({ track: "date-overtime", trackMessages: false });
    s.at(30, "guardian", "STOP");
    await s.runUntil(170);
    expect(s.timeline(29)).toEqual([
      "30 send guardian:stop_ack",
      "30 send user:usr_guardian_stopped",
      "135 send user:ot_overtime",
      "145 send user:lad_l1",
      "150 send user:lad_l2_text",
      "150 call user:checkin",
      "153 send user:usr_backup_unreachable", // X3: discreet, once
    ]);
    expect(s.sent.find((m) => m.template === "usr_guardian_stopped")!.text).toBe("Heads up, Priya can't anymore. Want to add someone else? Send their name and number."); // discreet: the plan is ACTIVE (I10)
    // The ladder still reaches L3, but nothing goes to the stopped guardian.
    expect(s.plan()!.state).toBe("ESCALATED");
    expect(s.sends(31, "guardian")).toEqual([]);
    expect(s.callLog.filter((c) => c.to === "guardian")).toEqual([]);
    expect(repo.getGuardianLink(s.store, s.user()!.id, s.plan()!.guardianId!)!.status).toBe("revoked");
  });

  it("S-20: he won't let me leave -> explicit distress -> L3 + exit call", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    s.at(60, "user", "he won't let me leave");
    await s.runUntil(61);
    expect(s.timeline(59)).toEqual(["60 send user:act_calling_you_now", "60 send guardian:gdn_alert", "60 call user:fake", "60 call guardian:guardian_alert"]);
    expect(s.routes.at(-1)!.route).toBe("distress");
    const alert = s.sent.find((m) => m.template === "gdn_alert")!.text;
    expect(alert).toContain("Alex texted me that they don't feel safe.");
    expect(alert).not.toContain("won't let me leave"); // 5.1: quote nothing
  });

  it("S-21: a Find My list() entry for someone else is dropped by the source guard (I2)", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    await s.runUntil(60);
    const planId = s.plan()!.id;
    const before = repo.listFixes(s.store, planId).length;
    const fix = { lat: 42.0, lng: -87.0, accuracyM: 10, at: s.clock.now(), locationType: "live" as const, expiresAt: null, source: "findmy" as const };
    expect(s.location.handler!(fix, STRANGER)).toBe(false);
    expect(s.location.handler!(fix, GUARDIAN)).toBe(false);
    await s.runUntil(61);
    const after = repo.listFixes(s.store, planId);
    expect(after.some((f) => f.lat === 42.0)).toBe(false);
    expect(after.length).toBe(before + 1); // only the user's own replay fix at minute 61
  });

  it("S-22: LLM down during CHECKING, user replies im good -> rule fallback resolves OK, no crash", async () => {
    const script = llmScript({ classify: [{ match: "im good", label: "OK" }] });
    const s = await dateSim({ track: "date-dark", trackMessages: false, llm: script });
    script.down = true;
    s.at(62, "user", "im good");
    await s.runUntil(70);
    expect(s.timeline(59)).toEqual(["60 send user:lad_l0_hard"]);
    expect(s.routes.at(-1)!.route).toBe("reply_ok");
    expect(s.channel.reacts.at(-1)!.messageId).toBe(s.inboundLog.at(-1)!.id);
    expect(s.transitions().slice(-2)).toEqual(["ACTIVE->CHECKING", "CHECKING->ACTIVE"]);
    // "im good" is settled by the deterministic clear-reply rule (spec 9.3 pre-pass), so the downed model is never needed.
    const llm = s.llm as unknown as { calls: { task: string }[] };
    expect(llm.calls.filter((c) => c.task === "classifyReply")).toHaveLength(0);
  });

  it("S-22b: LLM down during CHECKING, a reply only the model could judge -> AMBIGUOUS clarify, timer keeps running, no crash", async () => {
    const script = llmScript({});
    const s = await dateSim({ track: "date-dark", trackMessages: false, llm: script });
    script.down = true;
    s.at(62, "user", "honestly hes been really sweet");
    await s.runUntil(63);
    const llm = s.llm as unknown as { calls: { task: string }[] };
    expect(llm.calls.at(-1)!.task).toBe("classifyReply"); // the model was tried and failed
    expect(s.timeline(61).some((l) => l.includes("lad_clarify"))).toBe(true);
    expect(s.transitions().at(-1)).toBe("ACTIVE->CHECKING"); // still checking, not resolved
  });

  it("S-23: LiveKit down at the exit word -> fallback text within 5 s of place() returning false", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false, callsWork: false, callLatencyMs: 1300 });
    s.at(60, "user", "pineapple");
    await s.runUntil(61);
    expect(s.timeline(59)).toEqual(["60 send user:cw_exit_reply", "60 call user:fake (failed)", "60.02 send user:cw_call_fallback_text"]);
    const inAt = s.inboundLog.at(-1)!.at.getTime();
    const reply = s.sent.find((m) => m.template === "cw_exit_reply")!;
    const call = s.callLog[0]!;
    const fallback = s.sent.find((m) => m.template === "cw_call_fallback_text")!;
    expect(reply.at.getTime() - inAt).toBeLessThan(2000); // the reply does not wait for the call
    expect(call.placed).toBe(false);
    expect(fallback.at.getTime() - call.returnedAt.getTime()).toBeGreaterThanOrEqual(0);
    expect(fallback.at.getTime() - call.returnedAt.getTime()).toBeLessThan(5000);
    expect(fallback).toMatchObject({ text: "Call me asap", notifyAnyway: true });
    expect(repo.listPlanEvents(s.store, s.plan()!.id).some((e) => e.kind === "call_fallback")).toBe(true);
  });

  it("S-24: quota near cap -> onboarding paused, safety messages still sent", async () => {
    const s = await dateSim({ track: "date-overtime", trackMessages: false });
    await s.runUntil(120);
    s.quota.preload(QuotaPolicy.MESSAGES_PER_DAY - 3);
    expect(s.quota.nearCap()).toBe(true);
    expect(await s.text(STRANGER, "hi, a friend told me about you")).toBe("onboarding_quota");
    expect(s.sent.at(-1)).toMatchObject({ address: STRANGER, template: "quota_onboarding_paused" });
    expect(repo.getUserByAddress(s.store, STRANGER)).toBeNull();
    await s.runUntil(160);
    // Every ladder and guardian message still goes out, past the daily cap.
    expect(s.sends(121)).toEqual([
      "user:ot_overtime",
      "user:lad_l1",
      "user:lad_l2_text",
      "guardian:gdn_alert",
      "guardian:gdn_alert_repeat",
      "guardian:gdn_alert_repeat",
    ]);
    expect(s.quota.messages()).toBeGreaterThan(QuotaPolicy.MESSAGES_PER_DAY);
  });

  it("S-24 policy: near cap is 95% of 5,000 messages or of 50 new conversations per day", async () => {
    const s = new FullStack();
    sims.push(s);
    expect(s.quota.nearCap()).toBe(false);
    s.quota.preload(4749);
    expect(s.quota.nearCap()).toBe(false);
    s.quota.preload(1);
    expect(s.quota.nearCap()).toBe(true);
    const t = new FullStack();
    sims.push(t);
    t.quota.preload(0, 47);
    expect(t.quota.nearCap()).toBe(false);
    t.quota.preload(0, 1);
    expect(t.quota.nearCap()).toBe(true);
    expect(await t.text("other", "hi")).toBe("onboarding_quota");
  });
});

describe("full stack: replies, tapbacks, edits, dedupe", () => {
  it("4.5 step 3: Find My acceptance (found by the loc_poll job) gets a tapback on the user's latest message", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    const go = s.inboundLog.at(-1)!;
    await s.runUntil(-25);
    expect(s.plan()!.shareConfirmedAt).not.toBeNull();
    expect(s.channel.reacts.map((r) => r.messageId)).toEqual([go.id, go.id]); // GO, then share accepted
  });

  it("6.5 item 5: a thumbs-up tapback on the check-in resolves it", async () => {
    const s = await dateSim({ track: "date-dark", trackMessages: false });
    await s.runUntil(61);
    const check = s.sent.find((m) => m.template === "lad_l0_hard")!;
    await s.inbound("user", { kind: "reaction", emoji: "like", targetMessageId: check.id, removed: false });
    await s.runUntil(80);
    expect(s.routes.at(-1)!.route).toBe("reaction_dispatched");
    expect(s.transitions().slice(-1)).toEqual(["CHECKING->ACTIVE"]);
    expect(s.sends(61)).toEqual([]);
  });

  it("4.4.6 edit after arming (actually 8pm): timers move with the new start (plan_edited glue)", async () => {
    const s = new FullStack({
      track: "date-normal",
      trackMessages: false,
      llm: llmScript({
        extract: [
          { match: "jordan", out: DATE_EXTRACTION },
          { match: "actually 8", out: { startAtText: "8pm", startAtISO: new Date(START.getTime() + 60 * MIN).toISOString(), wantsToChange: ["startAt"] } },
        ],
      }),
    });
    sims.push(s);
    await s.onboard();
    await s.planDate();
    expect(await s.text("user", "actually 8pm")).toBe("intake_edit");
    expect(s.sent.at(-1)).toMatchObject({ template: "plan_edit_confirm", text: "Got it, now Sat 8:00 PM." });
    await s.runUntil(61);
    expect(s.timeline(-100)).toEqual(["30 send user:loc_request_intro", "60 send user:act_arrival"]);
    const p = s.plan()!;
    expect(p.startAt).toEqual(new Date(START.getTime() + 60 * MIN));
    expect(p.endAt).toEqual(new Date(START.getTime() + 180 * MIN));
    expect(p.state).toBe("ACTIVE");
  });

  it("8.4 step 4: a duplicate inbound id is processed once", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    await s.runUntil(60);
    expect(await s.inbound("user", { kind: "text", text: "pineapple" }, "dup-1")).toBe("codeword_exit");
    expect(await s.inbound("user", { kind: "text", text: "pineapple" }, "dup-1")).toBe("duplicate");
    expect(s.calls.attempts.length).toBe(1);
    expect(s.sent.filter((m) => m.template === "cw_exit_reply").length).toBe(1);
  });

  it("user STOP mid-plan: one ack, plan cancelled, engine sends after it are dropped", async () => {
    const s = await dateSim({ track: "date-normal", trackMessages: false });
    s.at(30, "user", "stop");
    await s.runUntil(200);
    expect(s.timeline(29)).toEqual(["30 send user:stop_ack"]);
    // X2: the engine itself skips sends to a stopped user, so nothing even reaches the executor.
    expect(s.dropped).toEqual([]);
    expect(repo.listPlanEvents(s.store, s.plan()!.id).some((e) => e.kind === "user_send_skipped_stopped" && e.data?.template === "plan_cancelled")).toBe(true);
    expect(s.plan()!.state).toBe("CANCELLED");
  });

  it("every user-facing message in a discreet state passes the discretion filter (I10)", async () => {
    const s = await dateSim({ track: "date-overtime", trackMessages: false });
    s.at(60, "user", "pineapple").at(140, "user", "hmm");
    await s.runUntil(200);
    expect(s.discreetSends().length).toBeGreaterThan(5);
    for (const m of s.discreetSends()) expect(isDiscreet(m.text), m.text).toBe(true);
  });
});
