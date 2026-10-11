// Fixed copy (spec 9.4): every TemplateId in contracts.ts renders here, no LLM.
// Spec copy is used verbatim where the spec gives it (4.2 to 4.9, 5.1, 6.6, 6.7, 7.6).
// Plain text only, no markdown, no em dashes, at most one emoji per message. Guardian alerts use
// only the leading warning sign. Copy reachable in DISCREET_STATES never uses banned words (I10).
import type {
  DecoyCaller,
  EscalationReason,
  Plan,
  PlanState,
  TemplateId,
  TemplateParams,
  Transport,
  TriggerId,
} from "../contracts.js";
import { TEMPLATE_IDS } from "../contracts.js";
import { FALLBACK_TZ, formatClock, formatClockRange, formatDayTime, isValidTz } from "../geo/timezone.js";
import { formatPhoneForDisplay } from "../util/phone.js";
import { isDiscreet } from "./discretion.js";

// TemplateParams and CloseReason live in contracts.ts (C1: the one canonical shape the engine
// emits and these templates read; the engine may not import notify/, I7 guard).
export type { CloseReason, TemplateParams } from "../contracts.js";

type Variant = (c: Ctx) => string;

class Ctx {
  constructor(readonly p: TemplateParams) {}
  get tz(): string {
    const t = this.p.tz;
    return isValidTz(t) ? t : FALLBACK_TZ;
  }
  get user(): string {
    return clean(this.p.userName) ?? "your friend";
  }
  get userOr(): string {
    return clean(this.p.userName) ?? "they";
  }
  get guardian(): string {
    return clean(this.p.guardianName) ?? "your backup";
  }
  get guardianCap(): string {
    return clean(this.p.guardianName) ?? "Your backup";
  }
  field<K extends keyof Plan & keyof TemplateParams>(k: K): TemplateParams[K] | undefined {
    const v = this.p[k];
    if (v !== undefined && v !== null) return v;
    const pv = this.p.plan?.[k];
    return (pv ?? undefined) as TemplateParams[K] | undefined;
  }
  date(v: Date | string | null | undefined): Date | null {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  get startAt(): Date | null {
    return this.date(this.field("startAt"));
  }
  get endAt(): Date | null {
    return this.date(this.field("endAt"));
  }
  get now(): Date {
    return this.date(this.p.now) ?? new Date();
  }
  dayTime(d: Date | null): string {
    return d ? formatDayTime(d, this.tz) : "the time you said";
  }
  clock(d: Date | null): string {
    return d ? formatClock(d, this.tz) : "the time you said";
  }
}

function clean(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t === "" ? null : t;
}

function lines(...ls: Array<string | null | undefined | false>): string {
  return ls.filter((l): l is string => typeof l === "string" && l.trim() !== "").join("\n");
}

function minutesText(n: number): string {
  return n === 1 ? "1 min" : `${n} min`;
}

export function durationText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  if (Number.isInteger(h)) return h === 1 ? "1 hour" : `${h} hours`;
  if (Number.isInteger(h * 2)) return `${h} hours`;
  return `${Math.floor(h)}h ${min % 60}m`;
}

function planLabel(c: Ctx): string {
  const type = c.field("type");
  const bos = c.field("buyOrSell");
  switch (type) {
    case "date":
      return "Date";
    case "marketplace":
      return bos === "buy" ? "Marketplace pickup" : bos === "sell" ? "Marketplace sale" : "Marketplace meetup";
    case "viewing":
      return "Apartment viewing";
    default:
      return "Meetup";
  }
}

function meetupNoun(c: Ctx): string {
  const type = c.field("type");
  const bos = c.field("buyOrSell");
  const base =
    type === "date"
      ? "a date"
      : type === "marketplace"
        ? bos === "buy"
          ? "a Marketplace pickup"
          : bos === "sell"
            ? "a Marketplace sale"
            : "a Marketplace meetup"
        : type === "viewing"
          ? "an apartment viewing"
          : "a meetup";
  return base + withCounterpart(c);
}

function withCounterpart(c: Ctx): string {
  const name = clean(c.field("counterpartName") as string | null | undefined);
  const src = clean(c.field("counterpartSource") as string | null | undefined);
  if (!name) return src ? ` (${src})` : "";
  return ` with ${name}${src ? ` (${src})` : ""}`;
}

/** "Date with Jordan (Hinge), Sat 7:00 PM at Lula Cafe, 2537 N Kedzie" */
export function describePlan(p: TemplateParams): string {
  const c = new Ctx(p);
  const venue = clean(c.field("venueText") as string | null | undefined);
  const start = c.startAt;
  return `${planLabel(c)}${withCounterpart(c)}${start ? `, ${c.dayTime(start)}` : ""}${venue ? ` at ${venue}` : ""}`;
}

function venueShort(c: Ctx): string | null {
  const v = clean(c.field("venueText") as string | null | undefined);
  if (!v) return null;
  return v.split(",")[0]!.trim();
}

function transportUser(t: Transport | null | undefined): string | null {
  switch (t) {
    case "self_drive":
      return "You're driving yourself.";
    case "rideshare":
      return "You're taking a rideshare.";
    case "transit":
      return "You're taking transit.";
    case "walk":
      return "You're walking.";
    case "their_car":
      return "They're driving you.";
    default:
      return null;
  }
}

function transportGuardian(c: Ctx): string | null {
  const name = c.user;
  const cp = clean(c.field("counterpartName") as string | null | undefined) ?? "the person they're meeting";
  switch (c.field("transport")) {
    case "self_drive":
      return `${name} is driving themselves.`;
    case "rideshare":
      return `${name} is taking a rideshare.`;
    case "transit":
      return `${name} is taking transit.`;
    case "walk":
      return `${name} is walking.`;
    case "their_car":
      return `${name} is riding with ${cp}.`;
    default:
      return null;
  }
}

function defaultsLine(c: Ctx): string | null {
  const used = c.p.defaultsUsed ?? [];
  if (used.includes("duration")) {
    const start = c.startAt;
    const end = c.endAt;
    const min = c.p.durationMin ?? (start && end ? Math.round((end.getTime() - start.getTime()) / 60000) : null);
    if (min) return `I'm assuming about ${durationText(min)}, tell me if it's longer.`;
  }
  return null;
}

/** Apple Maps link per spec 5.1: https://maps.apple.com/?ll=LAT,LNG&q=NAME */
export function appleMapsLink(lat: number, lng: number, name: string): string {
  return `https://maps.apple.com/?ll=${lat.toFixed(4)},${lng.toFixed(4)}&q=${encodeURIComponent(name)}`;
}

function minutesAgo(c: Ctx, at: Date): string {
  const m = Math.max(0, Math.round((c.now.getTime() - at.getTime()) / 60000));
  return m === 0 ? "just now" : `${minutesText(m)} ago`;
}

function locationLines(c: Ctx): string[] {
  const fix = c.p.fix;
  const at = fix ? c.date(fix.at) : null;
  if (!fix || !at) {
    const mode = c.p.locationMode ?? c.p.plan?.locationMode;
    return [mode === "none" ? `I don't have ${c.user}'s location for this meetup.` : `I don't have a recent location for ${c.user}.`];
  }
  const addr = clean(c.p.address);
  const acc = Math.round(fix.accuracyM);
  return [
    `Last location at ${c.clock(at)} (${minutesAgo(c, at)}, ±${acc} m)${addr ? `: ${addr}` : ""}`,
    appleMapsLink(fix.lat, fix.lng, c.user),
  ];
}

function silentMinutes(c: Ctx, reason: EscalationReason | null): number | null {
  if (typeof c.p.minutesSilent === "number") return c.p.minutesSilent;
  if (reason && reason.kind === "no_reply") return reason.minutesSilent;
  return null;
}

/** Spec 5.1 reason line, per trigger. Honest: states what is known, never certainty (I11). */
function reasonLine(c: Ctx): string {
  const name = c.user;
  const reason = c.p.reason ?? c.p.plan?.escalationReason ?? null;
  const during = ` during ${meetupNoun(c)}`;
  if (reason?.kind === "alert_word") {
    return `${name} sent me their private alert word. That means they want help but may not be able to talk.`;
  }
  if (reason?.kind === "distress") return `${name} texted me that they don't feel safe.`;
  if (reason?.kind === "not_ok_reply") return `${name} replied to my message in a way that sounded like they're not okay${during}.`;
  const mins = silentMinutes(c, reason);
  const minsText = mins !== null ? ` (${minutesText(Math.round(mins))})` : "";
  const trigger: TriggerId | null = (reason?.kind === "no_reply" ? reason.trigger : null) ?? c.p.trigger ?? c.p.plan?.ladderTrigger ?? null;
  switch (trigger) {
    case "T-DEP-CAR":
    case "T-DEP-CAR-THEIRS":
      return `${name} left the meetup by car and hasn't replied${minsText}${during}.`;
    case "T-DEP-WALK":
      return `${name} left the meetup on foot and hasn't replied${minsText}${during}.`;
    case "T-DARK":
      return `${name}'s location stopped updating and they haven't replied${minsText}${during}.`;
    case "T-FAR":
      return `${name} is far from the meetup spot and hasn't replied${minsText}${during}.`;
    case "T-NOARRIVE":
      return `${name} doesn't seem to have arrived at the meetup spot and hasn't replied${minsText}${during}.`;
    case "T-MKT-LONG":
      return `${name}'s meetup is running much longer than planned and they haven't replied${minsText}${during}.`;
    case "T-VENUE-CHG":
      return `${name} moved to a new spot and hasn't replied${minsText}${during}.`;
    case "T-POST-EXIT":
      return `${name} wanted a way out of the meetup and hasn't replied since${minsText}${during}.`;
    default: {
      const n = c.p.messagesUnanswered;
      const msgs = typeof n === "number" && n > 0 ? (n === 1 ? "my last message" : `my last ${n} messages`) : "my messages";
      const call = c.p.callPlaced ? " or a call" : "";
      return `${name} hasn't answered ${msgs}${call}${minsText}${during}.`;
    }
  }
}

/** L6 (I11): the repeat headline names the real reason; only a no-reply escalation claims silence. */
function repeatHeadline(c: Ctx, reason: EscalationReason | null, mins: number | null): string {
  switch (reason?.kind) {
    case "alert_word":
      return `⚠️ Reminder: ${c.user} sent me their private alert word and may not be able to talk.`;
    case "distress":
      return `⚠️ Reminder: ${c.user} texted me that they don't feel safe.`;
    case "not_ok_reply":
      return `⚠️ Reminder: ${c.user} replied in a way that sounded like they're not okay.`;
    default:
      return `⚠️ Still no reply from ${c.user}${mins !== null ? ` (${minutesText(Math.round(mins))})` : ""}.`;
  }
}

const WORRIED = "If you're still worried, keep trying to reach them, and call 911 if you think they're in danger.";

/** H2 (I11, 4.8): the guardian all-clear states how the plan ended and never claims more. */
function allClearLine(c: Ctx): string {
  const u = c.user;
  const thanks = "Thanks for being their backup.";
  switch (c.p.closeReason) {
    case "home":
    case "home_arrival":
      return `${u} is home safe. ${thanks}`;
    case "home_after_alert":
      return `${u} texted me that they're home. ${thanks}`;
    case "done":
      return `${u} told me the meetup is over and they're heading out. ${thanks}`;
    case "done_after_alert":
      return `${u} texted me that they're done and heading out, so I've stopped watching. I can't confirm they're okay. ${WORRIED}`;
    case "cancelled":
      return `${u} ended the plan, so I've stopped looking out for them. ${thanks}`;
    case "cancelled_after_alert":
      return `${u} ended the plan after my alert, so I've stopped watching. I can't confirm they're okay. ${WORRIED}`;
    case "timeout":
      return `${u} told me they were heading out, but I didn't see them get home within 90 minutes. I've stopped watching, so I can't confirm they made it home.`;
    case "max_extension":
      return `${u} replied that they're okay after a long meetup, so I've closed the plan. ${thanks}`;
    case "escalation_timeout":
      return `It's been 2 hours since my last update about ${u}, so I've stopped watching their location. I can't confirm they're okay. ${WORRIED}`;
    default:
      return `${u}'s plan has ended. ${thanks}`;
  }
}

function planLine(c: Ctx): string {
  const venue = venueShort(c);
  const start = c.startAt;
  const end = c.endAt;
  const range = start && end ? formatClockRange(start, end, c.tz) : start ? `starting ${c.clock(start)}` : null;
  const parts = [venue, range].filter((x): x is string => !!x).join(", ");
  const t = transportGuardian(c);
  return `Plan: ${parts || "no details"}.${t ? " " + t : ""}`;
}

const CODEWORD_REASONS: Record<string, string> = {
  format: "I couldn't tell which is which. Send them like: exit pineapple, alert blue moon",
  word_count: "Each one needs to be 1 to 3 words. Try again like: exit pineapple, alert blue moon",
  too_short: "Each one needs at least 5 letters so it can't go off by accident. Try again?",
  common_word: "That one's too common, you might text it by accident. Pick something more unusual?",
  same: "The two need to be different. Try again?",
  too_similar: "Those are too close to each other, I might mix them up. Pick two that look different?",
};

const GUARDIAN_INVALID_REASONS: Record<string, string> = {
  no_number: "I couldn't find a phone number there. Send their name and number, or share their contact card.",
  invalid: "That number doesn't look right. Can you double check it?",
  ambiguous: "Is that a US number? If not, send it with the country code, like +44 20 7946 0958.",
  own_number: "That's your own number. Who else should I contact if you might need help?",
  stopped: "That person asked me not to text them. Want to add someone else?",
  unreachable: "I can't reach that number right now. Want to try someone else?",
};

/** Fixed small talk answers (fallback for the LLM path; never sent in DISCREET_STATES). */
const SMALLTALK: Record<string, (c: Ctx) => string> = {
  who: () => "I'm Batman, an automated assistant. I quietly look out for you when you meet someone new.",
  what: () => "Tell me who, where, and when before you meet someone new. If something seems off and you don't answer me, I text your backup.",
  who_texted: (c) => `Only ${c.guardian}, and only if something seems off and you don't answer me.`,
  thanks: () => "Anytime.",
  greeting: () => "Hey!",
  how_are_you: () => "Doing well. Night owl hours are my favorite.",
  laugh: () => "Ha.",
  complaint: () => "Fair. Tell me what you meant and I'll fix it.",
};

/** One line that steers back to the pending step. */
const STEER: Record<string, (c: Ctx) => string> = {
  ask_name: () => "Anyway, what should I call you?",
  ask_guardian: () => "Anyway, who should be your backup? Send their name and number, or share their contact card.",
  questions: (c) => clean(c.p.questionsText) ?? "So, what time and where?",
  confirm: () => "Reply GO when you're ready, or tell me what to change.",
  idle: () => "Whenever you're meeting someone new, text me who, where, and when.",
  armed: (c) => `You're locked in for ${c.dayTime(c.startAt)}. Text me if anything changes.`,
  awaiting: (c) => `Still waiting on ${c.guardian} to say yes. I'll lock it in the moment they do.`,
};

const DISCREET: readonly PlanState[] = ["ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"];

const STATE_LINES: Partial<Record<PlanState, (c: Ctx) => string>> = {
  DRAFT: () => "Still setting this one up.",
  AWAITING_GUARDIAN: (c) => `Waiting on ${c.guardian} to say yes.`,
  ARMED: () => "Locked in.",
  PRE_MEETUP: () => "Locked in, starting soon.",
  ACTIVE: () => "Happening now.",
  OVERTIME: () => "Running long.",
  CHECKING: () => "Happening now.",
  ESCALATED: () => "Happening now.",
  CLOSING: () => "Wrapping up.",
};

const T: Record<TemplateId, Variant[]> = {
  // ---------- onboarding (4.2) ----------
  onb_hello: [
    () =>
      "Hey, I'm Batman. Text me before you meet someone new (a date, a Marketplace pickup, an apartment viewing) and I'll quietly look out for you.",
  ],
  onb_ask_name: [() => "Quick setup, takes a minute. What should I call you?"],
  onb_ask_guardian: [
    (c) =>
      `Nice to meet you, ${clean(c.p.userName) ?? "friend"}. Who should I contact if you might need help? Send me their name and number, or share their contact card.`,
  ],
  onb_guardian_texting: [
    (c) =>
      `Got it. I'll text ${c.guardian} to ask if they're okay being your backup. They'll only hear from me if you might need help.`,
  ],
  onb_guardian_green_bubble: [(c) => `${c.guardianCap} might get my texts as green bubbles.`],
  onb_ask_codewords: [
    (c) =>
      lines(
        "Now pick two secret code words. Text one of them to me anytime during a meetup:",
        '1) an EXIT word: your phone rings with a "call" so you have an excuse to leave',
        `2) an ALERT word: I quietly text ${c.guardian} your location`,
        "Pick words you'd never text by accident. Send them like: exit pineapple, alert blue moon",
      ),
  ],
  onb_codewords_invalid: [(c) => CODEWORD_REASONS[c.p.reasonId ?? "format"] ?? CODEWORD_REASONS.format!],
  onb_save_contact: [
    (c) =>
      c.p.changeOnly
        ? "Locked in. Your new code words are set."
        : 'Locked in. Last thing: save me as a contact under any name. Most people pick something boring like "Mom" so my texts look normal on your lock screen. I\'ll call from this same number when you use your exit word.',
  ],
  onb_disclosure_done: [
    () =>
      lines(
        "Heads up: I'm an automated assistant, not a person and not 911. I can't help if your phone is dead or has no signal, and I can fail if my service goes down. You must be 18+ to use me.",
        "You're all set. Text me before your next meetup.",
      ),
  ],
  onb_guardian_invalid: [(c) => GUARDIAN_INVALID_REASONS[c.p.reasonId ?? "no_number"] ?? GUARDIAN_INVALID_REASONS.no_number!],
  // Shared pool deviation from 4.3 (DECISIONS.md): Batman cannot text the guardian until the
  // guardian texts their assigned pool number first.
  onb_guardian_text_first: [
    (c) => {
      const num = clean(c.p.assignedNumber);
      const shown = num ? formatPhoneForDisplay(num) : "my number";
      const link = clean(c.p.smsLink);
      return lines(
        `Got it. Ask ${c.guardian} to text hi to ${shown} from their phone. That's my number for them, different from yours.`,
        `Once they do, I'll ask if they're okay being your backup.`,
        link ? `They can also tap this: ${link}` : null,
      );
    },
  ],

  // ---------- guardian opt-in (4.3) ----------
  gdn_optin_request: [
    (c) =>
      `Hi${clean(c.p.guardianName) ? " " + clean(c.p.guardianName) : ""}, ${c.user} added you as their backup on Batman, an automated assistant that looks out for people meeting strangers. You'd only hear from me if ${c.user} might need help. Reply YES to accept or NO to decline.`,
  ],
  gdn_optin_thanks: [
    (c) => `Thanks. If I ever text you about ${c.user}, it means they haven't answered me. Reply STOP anytime to stop these messages.`,
  ],
  gdn_optin_declined_ack: [(c) => `No problem. I won't text you about ${c.user}.`],
  usr_guardian_in: [(c) => `${c.guardianCap}'s in. 👍`],
  usr_guardian_declined: [(c) => `${c.guardianCap} declined, want to add someone else?`],
  usr_guardian_expired: [(c) => `${c.guardianCap} hasn't answered in 48 hours. Want to add someone else as your backup?`],
  usr_guardian_stopped: [
    (c) =>
      c.p.state && DISCREET.includes(c.p.state)
        ? `Heads up, ${clean(c.p.guardianName) ?? "they"} can't anymore. Want to add someone else? Send their name and number.`
        : `${c.guardianCap} opted out of being your backup. Want to add someone else?`,
  ],

  // ---------- intake and arming (4.4) ----------
  plan_confirm: [
    (c) =>
      lines(
        "Here's the plan:",
        describePlan(c.p),
        `${c.endAt ? `Back by about ${c.clock(c.endAt)}.` : ""}${transportUser(c.field("transport")) ? " " + transportUser(c.field("transport")) : ""}`.trim(),
        defaultsLine(c),
        clean(c.p.tip),
        `If something seems off I'll text you, then call you, then text ${c.guardian}.`,
        "Reply GO to lock it in, or tell me what to change.",
      ),
  ],
  plan_locked_in: [
    (c) => {
      const start = c.startAt;
      const ask = start ? new Date(start.getTime() - 30 * 60000) : null;
      if (c.p.soon || !ask || ask.getTime() <= c.now.getTime()) {
        return "Locked in. I'll ask you to share your location now, until it's over.";
      }
      return `Locked in. Around ${c.clock(ask)} I'll ask you to share your location until it's over.`;
    },
  ],
  plan_awaiting_guardian: [
    (c) =>
      lines(
        `Got it. ${c.guardianCap} hasn't said yes to being your backup yet, so I can't lock this in until they do. I'll lock it in the moment they reply.`,
        c.p.soon ? "Your meetup is soon. Want to use someone else? Send their name and number." : null,
      ),
  ],
  plan_armed_now: [(c) => `${c.guardianCap}'s in, you're locked in for ${c.dayTime(c.startAt)}.`],
  plan_replace_ask: [
    (c) => `You already have a plan: ${describePlan(c.p)}. Replace it with this new one? Reply YES to replace or NO to keep it.`,
  ],
  plan_time_past_ask: [(c) => `That time already passed. Did you mean ${c.dayTime(c.date(c.p.suggestedStart))}?`],
  plan_time_confirm_ask: [(c) => `Just to be sure, is that ${c.dayTime(c.date(c.p.suggestedStart) ?? c.startAt)}?`],
  plan_edit_confirm: [
    (c) => {
      const ch = (c.p.changes ?? []).filter((x) => x.trim() !== "");
      return ch.length > 0 ? `Got it, ${ch.join(", ")}.` : "Got it, updated.";
    },
  ],
  plan_cancelled: [() => "Okay, cancelled. Text me when you've got another one."],

  // ---------- pre-meetup (4.5) ----------
  loc_request_intro: [() => 'Tap Share on the card below and pick "Share Until End of Day." I\'ll stop looking when you\'re done.'],
  loc_reminder: [() => 'Reminder: tap Share on that location card and pick "Share Until End of Day."'],
  loc_pin_unsupported: [() => "Can you send that as a Maps link or just type the address?"],
  // Spec text is "I'll just check in on time"; reworded because "check in" is on the I10 list.
  loc_time_only: [() => "No location, no problem. I'll just go by the time."],
  loc_extend_ask: [
    (c) => {
      const exp = c.date(c.p.expiresAt);
      return `Your location share ends${exp ? ` at ${c.clock(exp)}` : " soon"}, before you'll be done. Mind sharing again with "Share Until End of Day"?`;
    },
  ],

  // ---------- active (4.6) ----------
  act_arrival: [() => "Have fun! Text me when you head out."],
  act_mid_check: [() => "How's it going?"],
  act_extend_confirm: [(c) => `Got it, back by about ${c.clock(c.endAt)} then.`],
  act_venue_confirm: [(c) => `Got it, ${venueShort(c) ?? "new spot"}.`],
  act_new_spot: [() => "New spot? 🙂"],
  act_calling_you_now: [() => "Calling you now."],

  // ---------- overtime and ladder (4.7, 6.4, 7.6) ----------
  ot_overtime: [() => 'Still out? Reply +30 if you\'re staying, or "home" when you\'re back.'],
  ot_max_confirm: [() => "You've been out a while. All good? Just reply and I'll wrap things up."],
  lad_l0_soft: [() => "Hey, everything good?", () => "How's it going? 🙂"],
  lad_l0_hard: [() => "Hey, text me back when you see this", () => "You good?"],
  lad_l0_noarrive: [() => "Did you make it there?"],
  lad_l0_post_exit: [() => "Did you get out okay?"],
  lad_l1: [() => "Text me back when you can 🙂"],
  lad_l2_text: [() => "Hey, can you text me back real quick?"],
  lad_clarify: [() => "All good? Just reply yes or no 🙂"],
  lad_resolved_after_escalation: [(c) => `Got it, glad you're okay. I'd let ${c.guardian} know too.`],
  lad_late_reply_discreet: [() => "Glad you texted. You good? Just reply yes or no."],

  // ---------- code words (6.6, 6.7). Innocuous, never mention a call or anyone else (I9). ----------
  cw_exit_reply: [() => "lol ok", () => "haha true", () => "omg ok one sec"],
  cw_alert_reply: [() => "haha ok"],
  cw_call_fallback_text: [() => "Call me asap"],

  // ---------- closure (4.8) ----------
  close_glad_back: [
    () => lines("Glad you're back. 👍 Plan closed and your location's no longer shared with me.", "(You can stop sharing in Find My too.)"),
  ],
  close_done_ack: [
    (c) =>
      c.p.closed
        ? lines("Sounds good. Plan closed and your location's no longer shared with me.", "(You can stop sharing in Find My too.)")
        : 'Sounds good. Text me "home" when you get there.',
  ],

  // ---------- guardian alerts and updates (5.1, 5.3, 5.4). Only the leading warning sign. ----------
  gdn_alert: [
    (c) =>
      lines(
        `⚠️ ${c.user} might need help.`,
        reasonLine(c),
        ...locationLines(c),
        planLine(c),
        `Please call ${c.user} now. If you think they're in danger, call 911.`,
        "Reply GOT IT so I know you're on it.",
      ),
  ],
  gdn_alert_repeat: [
    (c) => {
      const fix = c.p.fix;
      const at = fix ? c.date(fix.at) : null;
      const reason = c.p.reason ?? c.p.plan?.escalationReason ?? null;
      const mins = silentMinutes(c, reason);
      return lines(
        repeatHeadline(c, reason, mins),
        fix && at ? `Last location at ${c.clock(at)} (${minutesAgo(c, at)}): ${appleMapsLink(fix.lat, fix.lng, c.user)}` : null,
        `Please call ${c.user} now. Reply GOT IT so I know you're on it.`,
      );
    },
  ],
  gdn_location_update: [
    (c) => {
      const fix = c.p.fix;
      const at = fix ? c.date(fix.at) : null;
      if (!fix || !at) return `Update on ${c.user}: no new location yet.`;
      const addr = clean(c.p.address);
      return lines(
        `Update on ${c.user}: location at ${c.clock(at)} (${minutesAgo(c, at)}, ±${Math.round(fix.accuracyM)} m)${addr ? `: ${addr}` : ""}`,
        appleMapsLink(fix.lat, fix.lng, c.user),
      );
    },
  ],
  gdn_user_ok: [(c) => `Update: ${c.user} just replied that they're okay.`],
  gdn_user_ok_now: [(c) => `${c.user} says they're okay now.`],
  // H2 (I11): "home safe" only for a home reply or a detected home arrival.
  gdn_all_clear: [(c) => allClearLine(c)],
  gdn_location_denied: [() => "I only share location during an alert."],
  gdn_call_unavailable: [(c) => `I couldn't place a call to ${c.user} right now. Please try calling them yourself.`],

  // ---------- misc (4.9, I14, I16) ----------
  help: [
    () =>
      lines(
        "Text me before you meet someone new: who, where, and when. I'll quietly look out for you and text you if something seems off.",
        "Try: status, cancel, done, home, +30, change backup, change code words, change caller, delete my data.",
      ),
  ],
  status: [
    (c) => {
      if (!c.p.state && !c.p.plan) return "No plan right now. Text me before your next meetup.";
      const state = c.p.state ?? c.p.plan?.state ?? null;
      const end = c.endAt;
      const line = state ? STATE_LINES[state]?.(c) : null;
      return lines(`${describePlan(c.p)}${end ? `, back by about ${c.clock(end)}` : ""}.`, line);
    },
  ],
  stop_ack: [() => "Okay, I'll stop texting you."],
  plain_checkin_error: [() => "Hey, you good? Text me back when you can."],
  voice_unavailable: [() => "Couldn't hear that one, can you text it?"],
  unsupported_content: [() => "I can only read texts for now, can you type that out?"],
  delete_confirm_ask: [() => "This deletes your account, plans, and backup info for good. Reply YES to confirm, or anything else to keep it."],
  delete_done: [() => "Done, I deleted everything. Text me anytime if you want to start over."],
  quota_onboarding_paused: [() => "Hey, I'm full for new people today. Can you text me again tomorrow?"],

  // ---------- former EXTRA_COPY lines (9.4: fixed templates) ----------
  intake_questions: [(c) => clean(c.p.questionsText) ?? "What time is it, and where?"],
  ask_caller: [() => "Who should the fake call come from: mom, roommate, or boss?"],
  caller_set: [(c) => `Done, calls will come from "${c.p.decoyCaller ?? "roommate"}".`],
  codewords_busy: [() => "Let's do that after this one wraps up."],
  no_plan_distress: [() => "If you're in danger right now, call 911. I can only look out for you during a meetup you've told me about."],
  guardian_call_outside: [(c) => `I can only call ${clean(c.p.userName) ?? "them"} during a meetup they told me about.`],
  replace_kept: [() => "Okay, keeping your current plan."],
  delete_kept: [() => "Okay, nothing deleted."],
  ask_time_again: [() => "No problem, what time is it?"],
  ask_new_guardian: [() => "Who should be your new backup? Send their name and number, or share their contact card."],

  // ---------- guardian start notice (4.4.2 notifyGuardianStartEnd). No location (I4). ----------
  gdn_plan_started: [
    (c) => lines(`Heads up: ${c.user} is starting ${meetupNoun(c)}.`, planLine(c), "I'll text you when it's over. You'll only hear from me sooner if they might need help."),
  ],

  // ---------- M7, X3, X4 ----------
  plan_cancel_confirm_ask: [(c) => `Want me to cancel your plan for ${c.dayTime(c.startAt)}? Reply YES to cancel or NO to keep it.`],
  // Discreet (I10): reads like a friend's text on a lock screen.
  usr_backup_unreachable: [(c) => `Couldn't get hold of ${clean(c.p.guardianName) ?? "them"}. Text me when you can.`],
  // Plain explanation, only outside a window or once the user replies.
  usr_backup_unreachable_explain: [
    (c) => `Heads up: earlier I tried to reach ${c.guardian} for you and couldn't. If you need help right now, call 911. Want to add a different backup?`,
  ],
  plan_expired_unarmed: [
    (c) => `Your plan for ${c.dayTime(c.startAt)} expired because ${c.guardian} never said yes to being your backup. Text me if you want to set up another one.`,
  ],

  // ---------- confirm step (4.4.6): only the changed fields, never the full summary again ----------
  plan_updated: [
    (c) => {
      const ch = (c.p.changes ?? []).filter((x) => x.trim() !== "");
      return `Updated${ch.length > 0 ? `: ${ch.join(", ")}` : ""}. Reply GO to lock it in.`;
    },
  ],
  plan_go_nudge: [() => "Reply GO when you're ready, or tell me what to change."],
  plan_time_choice_ask: [
    (c) => {
      const [a, b] = (c.p.options ?? []).map((o) => c.date(o));
      return a && b ? `Just to be sure, ${c.dayTime(a)} or ${c.dayTime(b)}?` : "Just to be sure, what time is it?";
    },
  ],

  // ---------- small talk outside windows (4.1, 9.4): fallback when the model is unavailable ----------
  smalltalk_reply: [(c) => SMALLTALK[c.p.reasonId ?? ""]?.(c) ?? "Got it."],
  smalltalk_steer: [(c) => (STEER[c.p.step ?? ""] ?? STEER.idle!)(c)],
};

/** Templates sent to the guardian (not to the user). */
export const GUARDIAN_TEMPLATES: readonly TemplateId[] = [
  "gdn_optin_request",
  "gdn_optin_thanks",
  "gdn_optin_declined_ack",
  "gdn_alert",
  "gdn_alert_repeat",
  "gdn_location_update",
  "gdn_user_ok",
  "gdn_user_ok_now",
  "gdn_all_clear",
  "gdn_location_denied",
  "gdn_call_unavailable",
  "guardian_call_outside",
  "gdn_plan_started",
];

/** User-facing templates that are never sent inside a window (onboarding, intake, help). */
const PRE_WINDOW_ONLY: readonly TemplateId[] = [
  "onb_hello",
  "onb_ask_name",
  "onb_ask_guardian",
  "onb_guardian_texting",
  "onb_guardian_green_bubble",
  "onb_ask_codewords",
  "onb_codewords_invalid",
  "onb_save_contact",
  "onb_disclosure_done",
  "onb_guardian_invalid",
  "onb_guardian_text_first",
  "plan_confirm",
  "help",
  "quota_onboarding_paused",
  "intake_questions",
  "no_plan_distress",
  "usr_backup_unreachable_explain",
  "plan_expired_unarmed",
  "plan_updated",
  "plan_go_nudge",
  "plan_time_choice_ask",
  "smalltalk_reply",
  "smalltalk_steer",
];

/**
 * Every user-facing template that can be sent while a plan is in DISCREET_STATES. The I10
 * invariant test scans all variants of these for banned words. Dialogue code must not send a
 * template outside this list to a user whose plan is in a discreet state (see canSendInState).
 */
export const DISCREET_TEMPLATES: readonly TemplateId[] = TEMPLATE_IDS.filter(
  (id) => !GUARDIAN_TEMPLATES.includes(id) && !PRE_WINDOW_ONLY.includes(id),
);

export function canSendInState(id: TemplateId, state: PlanState | null): boolean {
  if (GUARDIAN_TEMPLATES.includes(id)) return true;
  if (state && (["ACTIVE", "OVERTIME", "CHECKING", "ESCALATED", "CLOSING"] as PlanState[]).includes(state)) {
    return DISCREET_TEMPLATES.includes(id);
  }
  return true;
}

/** Param keys that carry text the user (or a geocoder) supplied; dropped for the value-free variant (M6). */
const VALUE_KEYS = ["venueText", "counterpartName", "counterpartSource", "address", "changes", "tip", "questionsText"] as const;

/** M6: the same params with every user-supplied value removed (also from the embedded plan). */
export function valueFreeParams(params: TemplateParams | Record<string, unknown>): TemplateParams {
  const out: Record<string, unknown> = { ...params };
  for (const k of VALUE_KEYS) delete out[k];
  const plan = (params as TemplateParams).plan;
  if (plan) out.plan = { ...plan, venueText: null, counterpartName: null, counterpartSource: null };
  return out as TemplateParams;
}

/**
 * M6 (I10): render user-facing copy and check the RENDERED text in discreet states. If a value
 * the user typed makes it indiscreet, fall back to the value-free variant; if that still is not
 * discreet, return null (the caller drops the send and logs it).
 */
export function renderForUser(
  id: TemplateId,
  params: TemplateParams | Record<string, unknown>,
  state: PlanState | null | undefined,
  render: (id: TemplateId, params: TemplateParams | Record<string, unknown>) => string = (i, p) => renderTemplate(i, p),
): string | null {
  const text = render(id, params);
  if (!state || !DISCREET.includes(state) || isDiscreet(text)) return text;
  const alt = render(id, valueFreeParams(params));
  return isDiscreet(alt) ? alt : null;
}

export function variantCount(id: TemplateId): number {
  return T[id].length;
}

/** Render a template. Variants rotate randomly (rng injectable for tests) unless `variant` is set. */
export function renderTemplate(
  id: TemplateId,
  params: TemplateParams | Record<string, unknown> = {},
  opts: { rng?: () => number; variant?: number } = {},
): string {
  const variants = T[id];
  if (!variants || variants.length === 0) throw new Error(`unknown template ${id}`);
  const idx =
    opts.variant !== undefined
      ? Math.abs(opts.variant) % variants.length
      : Math.min(variants.length - 1, Math.floor((opts.rng ?? Math.random)() * variants.length));
  return variants[idx]!(new Ctx(params as TemplateParams));
}

/** All variants of a template rendered with the given params (tests and invariant scans). */
export function renderAllVariants(id: TemplateId, params: TemplateParams | Record<string, unknown> = {}): string[] {
  return T[id].map((v) => v(new Ctx(params as TemplateParams)));
}

// ---------- Former free-text dialogue lines, now TemplateIds (kept for callers and tests) ----------

export const EXTRA_COPY = {
  ask_caller: () => renderTemplate("ask_caller"),
  caller_set: (who: string) => renderTemplate("caller_set", { decoyCaller: who as DecoyCaller }),
  codewords_busy: () => renderTemplate("codewords_busy"),
  no_plan_distress: () => renderTemplate("no_plan_distress"),
  guardian_call_outside: (user: string) => renderTemplate("guardian_call_outside", { userName: user }),
  replace_kept: () => renderTemplate("replace_kept"),
  delete_kept: () => renderTemplate("delete_kept"),
  ask_time_again: () => renderTemplate("ask_time_again"),
  ask_new_guardian: () => renderTemplate("ask_new_guardian"),
} as const;

export type ExtraCopyId = keyof typeof EXTRA_COPY;
