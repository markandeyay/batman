// Dialogue manager: routes one normalized, deduped InboundMessage (spec 8.4 steps 5 to 10).
// Order (first match wins):
//   1. Code words, deterministically, when the sender's plan is in a WINDOW_STATE (I8). No LLM.
//   2. STOP from anyone (I14), START to undo.
//   3. Guardian keywords when the sender has an open guardian obligation (8.4 step 5).
//   4. Onboarding for users who have not finished it (4.2).
//   5. Deterministic keyword rules (8.4 step 8): distress, help, commands, status, flows.
//   6. Pending conversational context (delete, caller, code words, backup).
//   7. NLU: reply classification inside a window, intake extraction outside one.
// The manager never decides escalation (I7): it dispatches EngineEvents and the engine decides.
import type { DecoyCaller, E164, InboundMessage, Plan, User } from "../contracts.js";
import { DECOY_CALLERS, DISCREET_STATES, TERMINAL_STATES, WINDOW_STATES } from "../contracts.js";
import { classifyReply } from "../nlu/classifyReply.js";
import { isAffirmative, isNegative, isOkNow, matchKeywordRule, type KeywordRule } from "../nlu/rules.js";
import { matchCodeWords, normalizeText } from "../pipeline/codewords.js";
import { captureGuardian, currentGuardianFor, guardianHasObligation, guardianKeyword, handleGuardianInbound, stopGuardian } from "./guardian.js";
import { handleIntakeLocation, handleIntakeText, isAwaitingVenue } from "./intake.js";
import { handleCodewordReply, handleOnboarding, onboardingStep, startOnboarding } from "./onboarding.js";
import { sendTemplate } from "./out.js";
import type { DialoguePorts, DialogueState } from "./ports.js";

export interface HandleResult {
  route: string;
}

const STOP_RE = /^(stop|stop all|stopall|unsubscribe|stop texting me|stop messaging me|opt out|optout|end|quit)$/;
const START_RE = /^(start|unstop|resume)$/;

function inWindow(plan: Plan | null): plan is Plan {
  return plan !== null && WINDOW_STATES.includes(plan.state);
}

/** States before the meetup starts, where "done" asks to cancel (M7). */
const BEFORE_START: readonly Plan["state"][] = ["ARMED", "PRE_MEETUP", "AWAITING_GUARDIAN"];

function isOpen(plan: Plan | null): plan is Plan {
  return plan !== null && !TERMINAL_STATES.includes(plan.state);
}

export async function handleInbound(ports: DialoguePorts, msg: InboundMessage): Promise<HandleResult> {
  const route = await route_(ports, msg);
  ports.log?.info("dialogue_route", { route });
  return { route };
}

async function route_(ports: DialoguePorts, msg: InboundMessage): Promise<string> {
  const from = msg.from;
  const user = await ports.repo.getUserByAddress(from);
  const guardian = await ports.repo.getGuardianByAddress(from);
  const plan = user ? await ports.repo.getOpenPlanForUser(user.id) : null;
  const c = msg.content;
  const text = c.kind === "text" ? c.text : null;

  // 1. Code words first, for every onboarded user in every state, before anything else and
  //    before any model call (I8, H3). A code word never reaches the model.
  if (user && onboardingStep(user) === "done" && text !== null) {
    // Re-entering code words outside a window: the reply contains the words themselves.
    const ds0 = await ports.repo.getDialogueState(user.id);
    const reentering = ds0?.pending?.kind === "codewords" && !inWindow(plan);
    const cw = reentering ? null : await ports.repo.getCodeWords(user.id);
    const m = cw ? matchCodeWords(text, cw, { fromVoice: c.kind === "text" && c.fromVoice === true }) : null;
    if (m) {
      if (await ports.repo.isStopped(from)) await ports.repo.setStopped(from, null); // the user re-engaged
      if (isOpen(plan) && plan.state !== "DRAFT") {
        // The engine sends the innocuous reply and places the call or alert (6.6, 6.7, I9). It
        // also decides whether a guardian can be alerted before the window (H3).
        await ports.dispatch(plan.id, m.kind === "alert" ? { type: "alert_word", messageId: msg.id } : { type: "exit_word", messageId: msg.id });
      } else {
        // No armed plan: nothing to escalate. Reply like a friend and stop (I9).
        await sendTemplate(ports, from, m.kind === "alert" ? "cw_alert_reply" : "cw_exit_reply", {}, { planState: plan?.state ?? null });
      }
      return m.kind === "alert" ? "codeword_alert" : "codeword_exit";
    }
  }

  // 2. STOP / START (I14).
  if (text !== null) {
    const n = normalizeText(text);
    if (STOP_RE.test(n)) return handleStop(ports, from, user, guardian, plan);
    if (START_RE.test(n) && (await ports.repo.isStopped(from))) {
      await ports.repo.setStopped(from, null);
      if (guardian?.stoppedAt) await ports.repo.updateGuardian(guardian.id, { stoppedAt: null });
      await sendTemplate(ports, from, "help");
      return "start";
    }
  }

  // 3. Guardian obligation takes precedence for guardian keywords (8.4 step 5).
  if (guardian && text !== null && !guardian.stoppedAt) {
    const obligation = await guardianHasObligation(ports, guardian, user?.id ?? null);
    const kw = guardianKeyword(text);
    // A pending opt-in whose request has not been sent yet is unlocked by any first text.
    const unsent = (await ports.repo.listLinksForGuardian(guardian.id)).some((l) => l.status === "pending" && l.optinSentAt === null);
    if ((obligation && kw !== null) || (unsent && !inWindow(plan))) {
      return handleGuardianInbound(ports, guardian, text, user?.id ?? null);
    }
  }

  // 4. Users.
  if (user) {
    if (await ports.repo.isStopped(from)) await ports.repo.setStopped(from, null); // the user re-engaged
    if (onboardingStep(user) !== "done") return handleOnboarding(ports, user, msg);
    return handleUser(ports, user, plan, msg);
  }

  // 5. Guardians with no matching obligation (e.g. "where" with no alert, or chatter).
  if (guardian) {
    if (guardian.stoppedAt || text === null) return "guardian_ignored";
    return handleGuardianInbound(ports, guardian, text, null);
  }

  // 6. Unknown address: onboarding (4.2).
  if (await ports.repo.isStopped(from)) return "stopped_unknown_ignored";
  return startOnboarding(ports, from);
}

async function handleStop(
  ports: DialoguePorts,
  from: E164,
  user: User | null,
  guardian: import("../contracts.js").Guardian | null,
  plan: Plan | null,
): Promise<string> {
  if (!user && !guardian) return "stop_unknown";
  if (await ports.repo.isStopped(from)) return "stop_repeat";
  // One confirmation, then the flag; every later send to this address is dropped.
  await sendTemplate(ports, from, "stop_ack");
  await ports.repo.setStopped(from, ports.clock.now());
  if (guardian) await stopGuardian(ports, guardian);
  if (user) {
    await ports.repo.setDialogueState(user.id, null);
    if (isOpen(plan)) await ports.dispatch(plan.id, { type: "user_command", command: "cancel" });
  }
  return "stop";
}

async function handleUser(ports: DialoguePorts, user: User, plan: Plan | null, msg: InboundMessage): Promise<string> {
  const to = user.addressE164;
  const c = msg.content;
  const state = plan?.state ?? null;
  const ctx = { planState: state };

  switch (c.kind) {
    case "reaction": {
      if (c.removed) return "reaction_removed";
      if (inWindow(plan)) {
        await ports.dispatch(plan.id, { type: "user_reaction", emoji: c.emoji, targetMessageId: c.targetMessageId });
        return "reaction_dispatched";
      }
      const ds = await ports.repo.getDialogueState(user.id);
      // L7 (I1): only a positive tapback on Batman's plan confirmation means "go".
      const onConfirm = ds?.pending?.kind === "go" && !!ds.pending.confirmMessageId && c.targetMessageId === ds.pending.confirmMessageId;
      if (onConfirm && plan && (c.emoji === "like" || c.emoji === "love" || c.emoji === "emphasize")) {
        return handleIntakeText(ports, user, plan, { id: msg.id, text: "go" });
      }
      return "reaction_ignored";
    }
    case "voice_unavailable": {
      await sendTemplate(ports, to, "voice_unavailable", {}, ctx);
      if (plan && plan.state === "CHECKING") await ports.dispatch(plan.id, { type: "user_reply", label: "AMBIGUOUS", messageId: msg.id });
      return "voice_unavailable";
    }
    case "location": {
      if (inWindow(plan)) {
        await ports.dispatch(plan.id, {
          type: "fix",
          fix: { lat: c.lat, lng: c.lng, accuracyM: 50, at: msg.at, locationType: "pin", expiresAt: null, source: "pin" },
        });
        return "location_fix";
      }
      if (isOpen(plan)) return handleIntakeLocation(ports, user, plan, c.lat, c.lng);
      return "location_ignored";
    }
    case "contact": {
      const ds = await ports.repo.getDialogueState(user.id);
      if (ds?.pending?.kind === "new_guardian" || !(await currentGuardianFor(ports, user.id))) {
        const ok = await captureGuardian(ports, user, c);
        if (ok) await ports.repo.setDialogueState(user.id, { ...ds, pending: null });
        return ok ? "guardian_captured" : "guardian_invalid";
      }
      if (!inWindow(plan)) await sendTemplate(ports, to, "unsupported_content", {}, ctx);
      return "contact_ignored";
    }
    case "other": {
      if (plan && plan.state === "CHECKING") await ports.dispatch(plan.id, { type: "user_reply", label: "AMBIGUOUS", messageId: msg.id });
      // Location pins arrive with no coordinates (spike finding): ask for a link or an address.
      if (await isAwaitingVenue(ports, user, plan)) {
        await sendTemplate(ports, to, "loc_pin_unsupported", {}, ctx);
        return "pin_unsupported";
      }
      await sendTemplate(ports, to, "unsupported_content", {}, ctx);
      return "unsupported";
    }
    case "text":
      return handleUserText(ports, user, plan, msg.id, c.text, c.fromVoice === true);
  }
}

async function handleUserText(ports: DialoguePorts, user: User, plan: Plan | null, messageId: string, text: string, fromVoice: boolean): Promise<string> {
  const to = user.addressE164;
  const ctx = { planState: plan?.state ?? null };
  const rule = matchKeywordRule(text);
  const ds: DialogueState = (await ports.repo.getDialogueState(user.id)) ?? {};

  // Distress and help (4.6): inside a window "help" is explicit distress.
  if (rule?.kind === "distress" || (rule?.kind === "help" && inWindow(plan))) {
    if (isOpen(plan) && plan.state !== "DRAFT") {
      await ports.dispatch(plan.id, { type: "distress", messageId });
      return "distress";
    }
    if (rule.kind === "distress") {
      await sendTemplate(ports, to, "no_plan_distress", {}, ctx);
      return "distress_no_plan";
    }
  }
  if (rule) {
    const r = await handleRule(ports, user, plan, rule, messageId, ds);
    if (r) return r;
  }

  // Pending flows that are not intake.
  const p = ds.pending;
  if (p?.kind === "delete") {
    await ports.repo.setDialogueState(user.id, { ...ds, pending: null });
    if (isAffirmative(text) || normalizeText(text) === "delete") {
      if (isOpen(plan)) await ports.dispatch(plan.id, { type: "user_command", command: "cancel" });
      await ports.repo.deleteUserData(user.id);
      await sendTemplate(ports, to, "delete_done");
      return "deleted";
    }
    await sendTemplate(ports, to, "delete_kept", {}, ctx);
    return "delete_kept";
  }
  if (p?.kind === "caller") {
    const who = DECOY_CALLERS.find((d) => normalizeText(text).split(" ").includes(d));
    await ports.repo.setDialogueState(user.id, { ...ds, pending: null });
    if (who) {
      await ports.repo.updateUser(user.id, { decoyCaller: who as DecoyCaller });
      await sendTemplate(ports, to, "caller_set", { decoyCaller: who as DecoyCaller }, ctx);
      return "caller_set";
    }
  }
  if (p?.kind === "codewords") {
    const saved = await handleCodewordReply(ports, user, text, { changeOnly: true });
    if (saved) await ports.repo.setDialogueState(user.id, { ...ds, pending: null });
    return saved ? "codewords_changed" : "codewords_invalid";
  }
  if (p?.kind === "new_guardian") {
    if (/\d{3}/.test(text)) {
      const ok = await captureGuardian(ports, user, { kind: "text", text });
      if (ok) await ports.repo.setDialogueState(user.id, { ...ds, pending: null });
      return ok ? "guardian_captured" : "guardian_invalid";
    }
    if (isAffirmative(text)) {
      await sendTemplate(ports, to, "ask_new_guardian", {}, ctx);
      return "guardian_ask_new";
    }
    if (isNegative(text)) {
      await ports.repo.setDialogueState(user.id, { ...ds, pending: null });
      return "guardian_keep";
    }
  }

  // M7: confirmation for "done" before the meetup starts.
  if (p?.kind === "cancel_confirm") {
    await ports.repo.setDialogueState(user.id, { ...ds, pending: null });
    if (plan && plan.id === p.planId && isOpen(plan) && isAffirmative(text)) {
      await ports.dispatch(plan.id, { type: "user_command", command: "cancel" });
      return "cmd_cancel";
    }
    if (isNegative(text)) {
      await sendTemplate(ports, to, "replace_kept", {}, ctx);
      return "cancel_kept";
    }
  }

  // H1: a model-suggested venue change waits for the user's yes (only while ACTIVE).
  if (p?.kind === "moving_confirm") {
    await ports.repo.setDialogueState(user.id, { ...ds, pending: null });
    if (plan && plan.id === p.planId && plan.state === "ACTIVE" && isAffirmative(text)) {
      return dispatchCommand(ports, user, plan, "moving", null, p.venueText, p.venueText);
    }
    if (isNegative(text)) return "moving_declined";
  }

  // Inside a window: classify the reply and hand the label to the engine.
  if (inWindow(plan)) {
    // C2: "I'm okay now" is matched deterministically; it alone ends a silent escalation.
    if (isOkNow(text)) {
      await ports.dispatch(plan.id, { type: "user_reply", label: "OK", messageId, okNow: true });
      return "reply_ok_now";
    }
    const r = await ports.typing(to, () =>
      classifyReply({ text, fromVoice, state: plan.state, planType: plan.type, lastPrompt: null }, ports.llm),
    );
    if (r.distress) {
      await ports.dispatch(plan.id, { type: "distress", messageId });
      return "distress";
    }
    if (r.label === "COMMAND" && r.command === "moving" && r.source === "model") {
      // H1: never move the venue on a model guess. Ask first while ACTIVE; elsewhere treat the
      // reply as unclear so the ladder's clarify line goes out.
      if (plan.state === "ACTIVE") {
        await ports.repo.setDialogueState(user.id, { ...ds, pending: { kind: "moving_confirm", planId: plan.id, venueText: text.trim().slice(0, 200) } });
        await sendTemplate(ports, to, "act_new_spot", {}, { planState: plan.state });
        return "moving_confirm_ask";
      }
      await ports.dispatch(plan.id, { type: "user_reply", label: "AMBIGUOUS", messageId });
      return "reply_ambiguous";
    }
    if (r.label === "COMMAND" && r.command) return dispatchCommand(ports, user, plan, r.command, r.extendMin, r.venueText ?? null, text);
    if (r.label === "COMMAND") return "command_unknown";
    await ports.dispatch(plan.id, { type: "user_reply", label: r.label, messageId });
    return `reply_${r.label.toLowerCase()}`;
  }

  // Outside a window: intake (new plan, draft answers, edits of an armed plan).
  return handleIntakeText(ports, user, isOpen(plan) ? plan : null, { id: messageId, text });
}

async function dispatchCommand(
  ports: DialoguePorts,
  user: User,
  plan: Plan,
  command: "done" | "home" | "extend" | "cancel" | "moving",
  extendMin: number | null,
  venueText: string | null,
  rawText: string,
): Promise<string> {
  switch (command) {
    case "extend":
      await ports.dispatch(plan.id, { type: "user_command", command: "extend", minutes: extendMin ?? 30 });
      return "cmd_extend";
    case "moving": {
      const place = venueText ?? rawText;
      const near = plan.venueLat !== null && plan.venueLng !== null ? { lat: plan.venueLat, lng: plan.venueLng } : null;
      const g = (await ports.geocoder.geocode(place, { near, limit: 1 }).catch(() => []))[0];
      await ports.dispatch(plan.id, { type: "user_command", command: "moving", venueText: place, venueLat: g?.lat ?? null, venueLng: g?.lng ?? null });
      return "cmd_moving";
    }
    default:
      await ports.dispatch(plan.id, { type: "user_command", command });
      return `cmd_${command}`;
  }
}

/** Deterministic keyword rules (8.4 step 8). Returns null when the rule does not apply here. */
async function handleRule(
  ports: DialoguePorts,
  user: User,
  plan: Plan | null,
  rule: KeywordRule,
  messageId: string,
  ds: DialogueState,
): Promise<string | null> {
  const to = user.addressE164;
  const ctx = { planState: plan?.state ?? null };
  const tz = user.tz ?? ports.config.defaultTz;
  switch (rule.kind) {
    case "help":
      await sendTemplate(ports, to, "help", {}, ctx);
      return "help";
    case "status": {
      const cur = await currentGuardianFor(ports, user.id);
      await sendTemplate(ports, to, "status", isOpen(plan) ? { plan, state: plan.state, tz, guardianName: cur?.guardian.displayName ?? null } : {}, ctx);
      return "status";
    }
    case "cancel":
      if (isOpen(plan)) {
        await ports.repo.setDialogueState(user.id, null);
        await ports.dispatch(plan.id, { type: "user_command", command: "cancel" });
        return "cmd_cancel";
      }
      await sendTemplate(ports, to, "status", {}, ctx);
      return "cancel_no_plan";
    case "extend":
    case "home":
    case "done":
    case "moving":
      if (rule.kind === "done" && plan && BEFORE_START.includes(plan.state)) {
        // M7: "done" before the meetup starts most likely means "call it off". Ask first.
        await ports.repo.setDialogueState(user.id, { ...ds, pending: { kind: "cancel_confirm", planId: plan.id } });
        await sendTemplate(ports, to, "plan_cancel_confirm_ask", { plan, tz }, ctx);
        return "cancel_confirm_ask";
      }
      if (!inWindow(plan)) return null; // outside a window these are intake text
      return dispatchCommand(
        ports,
        user,
        plan,
        rule.kind,
        rule.kind === "extend" ? rule.minutes : null,
        rule.kind === "moving" ? rule.venueText : null,
        "",
      );
    case "delete_data":
      await ports.repo.setDialogueState(user.id, { ...ds, pending: { kind: "delete" } });
      await sendTemplate(ports, to, "delete_confirm_ask", {}, ctx);
      return "delete_ask";
    case "change_backup":
      await ports.repo.setDialogueState(user.id, { ...ds, pending: { kind: "new_guardian" } });
      await sendTemplate(ports, to, "ask_new_guardian", {}, ctx);
      return "change_backup";
    case "change_codewords":
      if (plan && DISCREET_STATES.includes(plan.state)) {
        // onb_ask_codewords names the alert word; never send it during a window (I10).
        await sendTemplate(ports, to, "codewords_busy", {}, ctx);
        return "codewords_busy";
      }
      await ports.repo.setDialogueState(user.id, { ...ds, pending: { kind: "codewords" } });
      {
        const cur = await currentGuardianFor(ports, user.id);
        await sendTemplate(ports, to, "onb_ask_codewords", { guardianName: cur?.guardian.displayName ?? null }, ctx);
      }
      return "change_codewords";
    case "change_caller":
      await ports.repo.setDialogueState(user.id, { ...ds, pending: { kind: "caller" } });
      await sendTemplate(ports, to, "ask_caller", {}, ctx);
      return "change_caller";
    case "stop":
    case "distress":
      return null; // handled earlier
  }
}

/** Timer entry point for the scheduler: guardian opt-in expiry. */
export { handleOptinExpire } from "./guardian.js";
