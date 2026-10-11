import { describe, expect, it } from "vitest";
import { TEMPLATE_IDS, TRIGGER_IDS, type TemplateId } from "../../../apps/server/src/contracts.js";
import { countEmoji, hasEmDash, hasMarkdown } from "../../../apps/server/src/notify/discretion.js";
import {
  GUARDIAN_TEMPLATES,
  appleMapsLink,
  describePlan,
  renderAllVariants,
  renderTemplate,
  type TemplateParams,
} from "../../../apps/server/src/notify/templates.js";
import { blankPlan } from "../../../apps/server/src/dialogue/memoryRepo.js";

const TZ = "America/Chicago";
const plan = blankPlan("u1", new Date("2026-10-17T20:00:00Z"), {
  type: "date",
  counterpartName: "Jordan",
  counterpartSource: "Hinge",
  venueText: "Lula Cafe",
  startAt: new Date("2026-10-18T00:00:00Z"), // Sat 7:00 PM CDT
  endAt: new Date("2026-10-18T02:00:00Z"),
  transport: "self_drive",
});

export const SAMPLE: TemplateParams = {
  plan,
  userName: "Alex",
  guardianName: "Priya",
  tz: TZ,
  now: new Date("2026-10-18T00:44:00Z"),
  reason: { kind: "no_reply", trigger: "T-OVR", minutesSilent: 6 },
  messagesUnanswered: 3,
  callPlaced: true,
  fix: { lat: 41.9139, lng: -87.68, accuracyM: 20, at: new Date("2026-10-18T00:42:00Z") },
  address: "1820 N Milwaukee Ave, Chicago",
  changes: ["now Sat 8:00 PM"],
  suggestedStart: new Date("2026-10-18T00:00:00Z"),
  expiresAt: new Date("2026-10-18T01:30:00Z"),
  assignedNumber: "+16285550100",
  smsLink: "sms:+16285550100",
  state: "ACTIVE",
  defaultsUsed: ["duration"],
  durationMin: 120,
};

describe("templates: every TemplateId renders", () => {
  it.each(TEMPLATE_IDS.map((id) => [id]))("%s is plain text with at most one emoji and no em dash", (id: TemplateId) => {
    for (const text of renderAllVariants(id, SAMPLE)) {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(hasEmDash(text)).toBe(false);
      expect(hasMarkdown(text)).toBe(false);
      expect(countEmoji(text)).toBeLessThanOrEqual(1);
      expect(text).not.toMatch(/undefined|null|NaN|\[object/);
    }
  });
});

describe("guardian alert (spec 5.1)", () => {
  it("matches the spec example exactly", () => {
    expect(renderTemplate("gdn_alert", SAMPLE)).toBe(
      [
        "⚠️ Alex might need help.",
        "Alex hasn't answered my last 3 messages or a call (6 min) during a date with Jordan (Hinge).",
        "Last location at 7:42 PM (2 min ago, ±20 m): 1820 N Milwaukee Ave, Chicago",
        "https://maps.apple.com/?ll=41.9139,-87.6800&q=Alex",
        "Plan: Lula Cafe, 7:00 to 9:00 PM. Alex is driving themselves.",
        "Please call Alex now. If you think they're in danger, call 911.",
        "Reply GOT IT so I know you're on it.",
      ].join("\n"),
    );
  });

  it("uses only the leading warning sign as emoji in guardian copy", () => {
    for (const id of GUARDIAN_TEMPLATES) {
      for (const t of renderAllVariants(id, SAMPLE)) {
        const n = countEmoji(t);
        if (n > 0) {
          expect(n).toBe(1);
          expect(t.startsWith("⚠️")).toBe(true);
        }
      }
    }
  });

  it.each([
    ["T-DEP-CAR", "left the meetup by car and hasn't replied"],
    ["T-DEP-CAR-THEIRS", "left the meetup by car and hasn't replied"],
    ["T-DARK", "location stopped updating and they haven't replied"],
    ["T-DEP-WALK", "left the meetup on foot"],
    ["T-NOARRIVE", "doesn't seem to have arrived"],
  ])("reason line for %s", (trigger, phrase) => {
    const t = renderTemplate("gdn_alert", { ...SAMPLE, reason: { kind: "no_reply", trigger: trigger as (typeof TRIGGER_IDS)[number], minutesSilent: 4 } });
    expect(t).toContain(phrase);
  });

  it("every trigger has a reason line that admits uncertainty (I11)", () => {
    for (const trigger of TRIGGER_IDS) {
      const t = renderTemplate("gdn_alert", { ...SAMPLE, reason: { kind: "no_reply", trigger, minutesSilent: 5 } });
      expect(t).toContain("might need help");
      expect(t).not.toMatch(/\b(is in danger|definitely|certainly|for sure)\b/i);
    }
  });

  it("alert word and distress variants (5.1)", () => {
    expect(renderTemplate("gdn_alert", { ...SAMPLE, reason: { kind: "alert_word" } })).toContain(
      "Alex sent me their private alert word. That means they want help but may not be able to talk.",
    );
    expect(renderTemplate("gdn_alert", { ...SAMPLE, reason: { kind: "distress" } })).toContain("Alex texted me that they don't feel safe.");
  });

  it("is honest when no call was placed and no location is known (I11)", () => {
    const t = renderTemplate("gdn_alert", { ...SAMPLE, callPlaced: false, messagesUnanswered: 2, fix: null, locationMode: "none" });
    expect(t).toContain("hasn't answered my last 2 messages (6 min)");
    expect(t).not.toContain("or a call");
    expect(t).toContain("I don't have Alex's location for this meetup.");
  });

  it("builds the Apple Maps link", () => {
    expect(appleMapsLink(41.9139, -87.68, "Alex Smith")).toBe("https://maps.apple.com/?ll=41.9139,-87.6800&q=Alex%20Smith");
  });
});

describe("spec copy verbatim", () => {
  it.each([
    ["onb_ask_name", "Quick setup, takes a minute. What should I call you?"],
    ["usr_guardian_in", "Priya's in. 👍"],
    ["usr_guardian_declined", "Priya declined, want to add someone else?"],
    ["ot_overtime", 'Still out? Reply +30 if you\'re staying, or "home" when you\'re back.'],
    ["lad_l1", "Text me back when you can 🙂"],
    ["lad_clarify", "All good? Just reply yes or no 🙂"],
    ["act_arrival", "Have fun! Text me when you head out."],
    ["act_new_spot", "New spot? 🙂"],
    ["act_calling_you_now", "Calling you now."],
    ["cw_alert_reply", "haha ok"],
    ["cw_call_fallback_text", "Call me asap"],
    ["lad_l0_noarrive", "Did you make it there?"],
    ["lad_l0_post_exit", "Did you get out okay?"],
    ["gdn_user_ok", "Update: Alex just replied that they're okay."],
    ["gdn_user_ok_now", "Alex says they're okay now."],
    ["gdn_all_clear", "Alex is home safe. Thanks for being their backup."],
    ["gdn_location_denied", "I only share location during an alert."],
    ["voice_unavailable", "Couldn't hear that one, can you text it?"],
    ["lad_resolved_after_escalation", "Got it, glad you're okay. I'd let Priya know too."],
    ["loc_pin_unsupported", "Can you send that as a Maps link or just type the address?"],
  ])("%s", (id, text) => {
    // H2: the spec's all-clear line is the home case; other close reasons get their own copy.
    const params = id === "gdn_all_clear" ? { ...SAMPLE, closeReason: "home" as const } : SAMPLE;
    expect(renderTemplate(id as TemplateId, params, { variant: 0 })).toBe(text);
  });

  it("rotates exit replies among the spec variants (6.6)", () => {
    expect(renderAllVariants("cw_exit_reply")).toEqual(["lol ok", "haha true", "omg ok one sec"]);
    expect(renderAllVariants("lad_l0_soft")).toEqual(["Hey, everything good?", "How's it going? 🙂"]);
    expect(renderAllVariants("lad_l0_hard")).toEqual(["Hey, text me back when you see this", "You good?"]);
    const seen = new Set([0, 0.4, 0.9].map((r) => renderTemplate("cw_exit_reply", {}, { rng: () => r })));
    expect(seen.size).toBe(3);
  });

  it("plan confirmation (4.4.6)", () => {
    const t = renderTemplate("plan_confirm", { ...SAMPLE, plan: { ...plan, venueText: "Lula Cafe, 2537 N Kedzie" }, defaultsUsed: [] });
    expect(t).toBe(
      [
        "Here's the plan:",
        "Date with Jordan (Hinge), Sat 7:00 PM at Lula Cafe, 2537 N Kedzie",
        "Back by about 9:00 PM. You're driving yourself.",
        "If something seems off I'll text you, then call you, then text Priya.",
        "Reply GO to lock it in, or tell me what to change.",
      ].join("\n"),
    );
  });

  it("states defaults that were used", () => {
    expect(renderTemplate("plan_confirm", SAMPLE)).toContain("I'm assuming about 2 hours, tell me if it's longer.");
  });

  it("locked in mentions the T-30 time", () => {
    expect(renderTemplate("plan_locked_in", { ...SAMPLE, now: new Date("2026-10-17T20:00:00Z") })).toBe(
      "Locked in. Around 6:30 PM I'll ask you to share your location until it's over.",
    );
  });

  it("guardian opt-in request carries no plan details (I1)", () => {
    const t = renderTemplate("gdn_optin_request", SAMPLE);
    expect(t).toBe(
      "Hi Priya, Alex added you as their backup on Batman, an automated assistant that looks out for people meeting strangers. You'd only hear from me if Alex might need help. Reply YES to accept or NO to decline.",
    );
    for (const detail of ["Jordan", "Lula", "Hinge", "7:00", "date"]) expect(t).not.toContain(detail);
  });

  it("guardian text-first instructions (shared pool) fit in 3 lines", () => {
    const t = renderTemplate("onb_guardian_text_first", SAMPLE);
    expect(t.split("\n").length).toBeLessThanOrEqual(3);
    expect(t).toContain("Ask Priya to text hi to (628) 555-0100 from their phone.");
    expect(t).toContain("different from yours");
    expect(t).toContain("sms:+16285550100");
    expect(renderTemplate("onb_guardian_text_first", { ...SAMPLE, smsLink: null }).split("\n").length).toBe(2);
  });

  it("describes plans compactly", () => {
    expect(describePlan({ plan, tz: TZ })).toBe("Date with Jordan (Hinge), Sat 7:00 PM at Lula Cafe");
    expect(describePlan({ type: "marketplace", buyOrSell: "sell", tz: TZ })).toBe("Marketplace sale");
  });
});
