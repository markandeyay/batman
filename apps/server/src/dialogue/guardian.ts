// Guardian dialogue (spec 4.3, 5.4, 8.4 step 5) with the shared-pool deviation (DECISIONS.md):
// Batman cannot text a guardian until the guardian texts their assigned pool number first. So
// naming a guardian registers them and tells the user to have the guardian text "hi"; the
// guardian's first inbound text triggers gdn_optin_request. The 48 h expiry starts when the user
// names the guardian. I1: nothing about any plan reaches the guardian before YES.
import type { E164, Guardian, InboundContent, Plan, User } from "../contracts.js";
import { TERMINAL_STATES, WINDOW_STATES } from "../contracts.js";
import { EXTRA_COPY } from "../notify/templates.js";
import { normalizeText } from "../pipeline/codewords.js";
import { isAffirmative, isNegative } from "../nlu/rules.js";
import { findPhonesInText, parsePhone } from "../util/phone.js";
import { sendTemplate, sendText } from "./out.js";
import type { DialoguePorts, GuardianLink } from "./ports.js";

export const OPTIN_TTL_MS = 48 * 3600_000;

export type GuardianKeyword = "yes" | "no" | "ack" | "where" | "call";

/** Guardian keywords (spec 5.4, 4.3). STOP is handled globally before this. */
export function guardianKeyword(text: string): GuardianKeyword | null {
  const n = normalizeText(text);
  if (n === "") return /\u{1F44D}/u.test(text) ? "ack" : null;
  if (/^(got it|gotit|got it thanks|on it|im on it|will do|ack|roger|copy|ok got it|okay got it|calling now|calling)$/.test(n)) return "ack";
  if (/\b(ill|i will|im|i am|gonna|going to)\s+(call|calling|try calling)\b/.test(n) || /^calling (her|him|them)( now)?$/.test(n)) return "ack";
  if (/\bwhere\b|\blocation\b|\bwhere is (she|he|they)\b/.test(n)) return "where";
  if (/\b(call|ring)\s+(her|him|them)\b|\bcan you call\b|\bplease call\b/.test(n)) return "call";
  if (isAffirmative(text)) return n === "ok" || n === "okay" || n === "k" ? "ack" : "yes";
  if (isNegative(text)) return "no";
  if (/^(i accept|accept|count me in|happy to help|of course|yes of course)$/.test(n)) return "yes";
  if (/^(decline|i decline|no sorry|sorry no|i cant|cant do it)$/.test(n)) return "no";
  return null;
}

function isLive(link: GuardianLink, now: Date): boolean {
  return link.status === "pending" && now.getTime() < link.requestedAt.getTime() + OPTIN_TTL_MS;
}

async function livePending(ports: DialoguePorts, guardian: Guardian): Promise<GuardianLink[]> {
  const now = ports.clock.now();
  const links = await ports.repo.listLinksForGuardian(guardian.id);
  return links.filter((l) => isLive(l, now)).sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
}

async function escalatedPlans(ports: DialoguePorts, guardian: Guardian, selfUserId: string | null): Promise<Plan[]> {
  const plans = await ports.repo.listOpenPlansForGuardian(guardian.id);
  return plans.filter((p) => p.state === "ESCALATED" && p.userId !== selfUserId);
}

/**
 * An open guardian obligation (spec 8.4 step 5): a pending opt-in, or an active escalation for
 * someone else. When true, guardian keywords take precedence over the person's own user role.
 */
export async function guardianHasObligation(ports: DialoguePorts, guardian: Guardian, selfUserId: string | null): Promise<boolean> {
  if ((await livePending(ports, guardian)).length > 0) return true;
  return (await escalatedPlans(ports, guardian, selfUserId)).length > 0;
}

async function userName(ports: DialoguePorts, userId: string): Promise<string | null> {
  return (await ports.repo.getUser(userId))?.displayName ?? null;
}

async function sendOptinRequest(ports: DialoguePorts, guardian: Guardian, link: GuardianLink): Promise<void> {
  const name = await userName(ports, link.userId);
  // I1: only the user's name. No plan details before YES.
  await sendTemplate(ports, guardian.addressE164, "gdn_optin_request", { userName: name, guardianName: guardian.displayName });
  await ports.repo.upsertLink({ ...link, optinSentAt: ports.clock.now() });
}

async function sendNextUnsentOptin(ports: DialoguePorts, guardian: Guardian): Promise<boolean> {
  const pending = await livePending(ports, guardian);
  if (pending.some((l) => l.optinSentAt !== null)) return false;
  const next = pending.find((l) => l.optinSentAt === null);
  if (!next) return false;
  await sendOptinRequest(ports, guardian, next);
  return true;
}

async function acceptLink(ports: DialoguePorts, guardian: Guardian, link: GuardianLink): Promise<void> {
  const now = ports.clock.now();
  await ports.repo.upsertLink({ ...link, status: "accepted", respondedAt: now });
  const user = await ports.repo.getUser(link.userId);
  await sendTemplate(ports, guardian.addressE164, "gdn_optin_thanks", { userName: user?.displayName ?? null });
  if (!user || user.deletedAt) return;
  // Change backup: the newly accepted guardian replaces any previously accepted one.
  for (const other of await ports.repo.listLinksForUser(user.id)) {
    if (other.guardianId !== guardian.id && (other.status === "accepted" || other.status === "pending")) {
      await ports.repo.upsertLink({ ...other, status: "revoked", respondedAt: now });
    }
  }
  const plan = await ports.repo.getOpenPlanForUser(user.id);
  const state = await ports.repo.getDialogueState(user.id);
  if (state?.pending?.kind === "new_guardian") await ports.repo.setDialogueState(user.id, { ...state, pending: null });
  await sendTemplate(ports, user.addressE164, "usr_guardian_in", { guardianName: guardian.displayName }, { planState: plan?.state ?? null });
  if (plan && plan.state !== "ESCALATED" && plan.guardianId !== guardian.id) {
    await ports.repo.updatePlanFields(plan.id, { guardianId: guardian.id });
  }
  if (plan && plan.state === "AWAITING_GUARDIAN") await ports.dispatch(plan.id, { type: "guardian_accepted" });
}

async function declineLink(ports: DialoguePorts, guardian: Guardian, link: GuardianLink): Promise<void> {
  await ports.repo.upsertLink({ ...link, status: "declined", respondedAt: ports.clock.now() });
  const user = await ports.repo.getUser(link.userId);
  await sendTemplate(ports, guardian.addressE164, "gdn_optin_declined_ack", { userName: user?.displayName ?? null });
  if (user && !user.deletedAt) await tellUserBackupGone(ports, user, guardian, "usr_guardian_declined");
}

async function tellUserBackupGone(
  ports: DialoguePorts,
  user: User,
  guardian: Guardian,
  template: "usr_guardian_declined" | "usr_guardian_expired" | "usr_guardian_stopped",
  opts: { alreadyToldByEngine?: boolean } = {},
): Promise<void> {
  const plan = await ports.repo.getOpenPlanForUser(user.id);
  if (!opts.alreadyToldByEngine) {
    await sendTemplate(ports, user.addressE164, template, { guardianName: guardian.displayName }, { planState: plan?.state ?? null });
  }
  const state = (await ports.repo.getDialogueState(user.id)) ?? {};
  if (user.onboardingStep === "done" && !state.pending) await ports.repo.setDialogueState(user.id, { ...state, pending: { kind: "new_guardian" } });
}

/** Inbound text from a guardian (after code words and STOP). Returns a route label. */
export async function handleGuardianInbound(
  ports: DialoguePorts,
  guardian: Guardian,
  text: string,
  selfUserId: string | null,
): Promise<string> {
  const pending = await livePending(ports, guardian);
  const awaitingAnswer = pending.filter((l) => l.optinSentAt !== null);
  const escalated = await escalatedPlans(ports, guardian, selfUserId);
  const kw = guardianKeyword(text);

  // Escalation commands first: an active alert outranks consent bookkeeping.
  if (escalated.length > 0) {
    if (kw === "ack") {
      for (const p of escalated) await ports.dispatch(p.id, { type: "guardian_ack" });
      return "guardian_ack";
    }
    if (kw === "where") {
      for (const p of escalated) await ports.dispatch(p.id, { type: "guardian_location_request" });
      return "guardian_where";
    }
  }
  if (kw === "call") {
    const plans = (await ports.repo.listOpenPlansForGuardian(guardian.id)).filter((p) => WINDOW_STATES.includes(p.state) && p.userId !== selfUserId);
    const allowed: Plan[] = [];
    for (const p of plans) {
      const link = await ports.repo.getLink(p.userId, guardian.id);
      if (link?.status === "accepted") allowed.push(p);
    }
    if (allowed.length > 0) {
      for (const p of allowed) await ports.dispatch(p.id, { type: "guardian_call_request" });
      return "guardian_call";
    }
    const accepted = (await ports.repo.listLinksForGuardian(guardian.id)).find((l) => l.status === "accepted");
    const name = accepted ? await userName(ports, accepted.userId) : null;
    await sendText(ports, guardian.addressE164, EXTRA_COPY.guardian_call_outside(name ?? "them"));
    return "guardian_call_outside";
  }

  // Consent: answer to a request already sent.
  const current = awaitingAnswer[0];
  if (current && (kw === "yes" || (kw === "ack" && escalated.length === 0))) {
    await acceptLink(ports, guardian, current);
    await sendNextUnsentOptin(ports, guardian);
    return "guardian_accept";
  }
  if (current && kw === "no") {
    await declineLink(ports, guardian, current);
    await sendNextUnsentOptin(ports, guardian);
    return "guardian_decline";
  }

  // Shared pool: the guardian's first text unlocks the opt-in request.
  if (await sendNextUnsentOptin(ports, guardian)) return "guardian_optin_sent";

  if (kw === "where") {
    await sendTemplate(ports, guardian.addressE164, "gdn_location_denied");
    return "guardian_where_denied";
  }
  return "guardian_ignored";
}

/** Timer: guardian opt-in expiry (JobKind "optin_expire", payload { userId, guardianId }). */
export async function handleOptinExpire(ports: DialoguePorts, payload: { userId: string; guardianId: string }): Promise<void> {
  const link = await ports.repo.getLink(payload.userId, payload.guardianId);
  if (!link || link.status !== "pending") return;
  if (ports.clock.now().getTime() < link.requestedAt.getTime() + OPTIN_TTL_MS) return;
  await ports.repo.upsertLink({ ...link, status: "expired", respondedAt: ports.clock.now() });
  const user = await ports.repo.getUser(link.userId);
  const guardian = await ports.repo.getGuardian(link.guardianId);
  if (user && guardian && !user.deletedAt) await tellUserBackupGone(ports, user, guardian, "usr_guardian_expired");
}

/** Guardian side of STOP (I14). The caller sends stop_ack and sets the address stop flag. */
export async function stopGuardian(ports: DialoguePorts, guardian: Guardian): Promise<void> {
  const now = ports.clock.now();
  await ports.repo.updateGuardian(guardian.id, { stoppedAt: now });
  // The engine's guardian_stop row tells the plan's user (usr_guardian_stopped, DECISIONS.md
  // core item 7), so the loop below must not tell them a second time.
  const toldByEngine = new Set<string>();
  for (const p of await ports.repo.listOpenPlansForGuardian(guardian.id)) {
    if (!TERMINAL_STATES.includes(p.state)) {
      await ports.dispatch(p.id, { type: "guardian_stop" });
      toldByEngine.add(p.userId);
    }
  }
  for (const link of await ports.repo.listLinksForGuardian(guardian.id)) {
    if (link.status !== "pending" && link.status !== "accepted") continue;
    await ports.repo.upsertLink({ ...link, status: "revoked", respondedAt: now });
    const user = await ports.repo.getUser(link.userId);
    if (user && !user.deletedAt && user.addressE164 !== guardian.addressE164) {
      await tellUserBackupGone(ports, user, guardian, "usr_guardian_stopped", { alreadyToldByEngine: toldByEngine.has(user.id) });
    }
  }
}

// ---------- Capturing a guardian from the user (onboarding and "change backup") ----------

export type GuardianCandidate = { ok: true; e164: E164; name: string | null } | { ok: false; reasonId: "no_number" | "invalid" | "ambiguous" };

const NAME_FILLER = new Set([
  "its", "it", "is", "her", "his", "their", "number", "num", "phone", "cell", "mobile", "and", "name", "named", "contact", "the",
  "at", "on", "my", "backup", "should", "be", "use", "add", "please", "pls", "ok", "okay", "sure",
]);

function cleanName(raw: string): string | null {
  const toks = raw
    .replace(/[^\p{L}\p{M}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_FILLER.has(t.toLowerCase().replace(/'/g, "")));
  if (toks.length === 0) return null;
  const caps = toks.filter((t) => /^\p{Lu}/u.test(t));
  const chosen = (toks.length <= 3 ? toks : caps.length > 0 ? caps.slice(0, 2) : toks.slice(-2)).join(" ");
  const name = chosen.slice(0, 40).trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

export function parseGuardianCandidate(content: InboundContent): GuardianCandidate {
  if (content.kind === "contact") {
    let sawAmbiguous = false;
    for (const ph of content.phones) {
      const r = parsePhone(ph);
      if (r.ok) return { ok: true, e164: r.e164, name: content.name?.trim() || null };
      if (r.reason === "ambiguous") sawAmbiguous = true;
    }
    return { ok: false, reasonId: content.phones.length === 0 ? "no_number" : sawAmbiguous ? "ambiguous" : "invalid" };
  }
  if (content.kind !== "text") return { ok: false, reasonId: "no_number" };
  const text = content.text;
  const found = findPhonesInText(text);
  if (found.length > 0) {
    const f = found[0]!;
    const rest = (text.slice(0, f.start) + " " + text.slice(f.end)).trim();
    return { ok: true, e164: f.e164, name: cleanName(rest) };
  }
  if (/\d{3,}/.test(text)) {
    const digits = text.match(/\+?[\d\s().-]{7,}/)?.[0] ?? "";
    const r = parsePhone(digits);
    return { ok: false, reasonId: r.ok ? "invalid" : r.reason };
  }
  return { ok: false, reasonId: "no_number" };
}

/**
 * Register a guardian for the user and start consent. Returns true when a guardian was
 * captured (the caller moves on), false when the user was asked to try again.
 */
export async function captureGuardian(ports: DialoguePorts, user: User, content: InboundContent): Promise<boolean> {
  const cand = parseGuardianCandidate(content);
  const to = user.addressE164;
  if (!cand.ok) {
    await sendTemplate(ports, to, "onb_guardian_invalid", { reasonId: cand.reasonId });
    return false;
  }
  if (cand.e164 === user.addressE164) {
    await sendTemplate(ports, to, "onb_guardian_invalid", { reasonId: "own_number" });
    return false;
  }
  const existing = await ports.repo.getGuardianByAddress(cand.e164);
  if ((existing && existing.stoppedAt) || (await ports.repo.isStopped(cand.e164))) {
    await sendTemplate(ports, to, "onb_guardian_invalid", { reasonId: "stopped" });
    return false;
  }
  const now = ports.clock.now();
  let guardian = existing;
  if (guardian) {
    const link = await ports.repo.getLink(user.id, guardian.id);
    if (link?.status === "accepted") {
      await sendTemplate(ports, to, "usr_guardian_in", { guardianName: guardian.displayName ?? cand.name });
      return true;
    }
  }
  const reg = await ports.registerGuardianAddress(cand.e164);
  if (!reg) {
    await sendTemplate(ports, to, "onb_guardian_invalid", { reasonId: "unreachable" });
    return false;
  }
  if (!guardian) guardian = await ports.repo.createGuardian(cand.e164, cand.name, now);
  else if (!guardian.displayName && cand.name) {
    await ports.repo.updateGuardian(guardian.id, { displayName: cand.name });
    guardian = { ...guardian, displayName: cand.name };
  }
  const link: GuardianLink = { userId: user.id, guardianId: guardian.id, status: "pending", requestedAt: now, respondedAt: null, optinSentAt: null };
  await ports.repo.upsertLink(link);
  await ports.schedule({
    kind: "optin_expire",
    runAt: new Date(now.getTime() + OPTIN_TTL_MS),
    planId: null,
    payload: { userId: user.id, guardianId: guardian.id },
  });

  // Has this person already texted Batman (an existing user, or a guardian we already reached)?
  const alreadyReachable =
    (await ports.repo.getUserByAddress(cand.e164)) !== null ||
    (await ports.repo.listLinksForGuardian(guardian.id)).some((l) => l.optinSentAt !== null);
  const guardianName = guardian.displayName ?? cand.name;
  if (alreadyReachable) {
    const awaiting = (await livePending(ports, guardian)).some((l) => l.optinSentAt !== null && l.userId !== user.id);
    if (!awaiting) await sendOptinRequest(ports, guardian, link);
    await sendTemplate(ports, to, "onb_guardian_texting", { guardianName });
  } else {
    await sendTemplate(ports, to, "onb_guardian_text_first", {
      guardianName,
      assignedNumber: reg.assignedNumber,
      smsLink: reg.smsLink,
    });
  }
  return true;
}

/** The user's current backup: accepted link first, else the newest live pending one. */
export async function currentGuardianFor(ports: DialoguePorts, userId: string): Promise<{ guardian: Guardian; link: GuardianLink } | null> {
  const now = ports.clock.now();
  const links = await ports.repo.listLinksForUser(userId);
  const accepted = links.find((l) => l.status === "accepted");
  const pick = accepted ?? links.filter((l) => isLive(l, now)).sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];
  if (!pick) return null;
  const guardian = await ports.repo.getGuardian(pick.guardianId);
  return guardian ? { guardian, link: pick } : null;
}
