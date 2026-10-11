// Onboarding (spec 4.2). Resumable: the step lives in users.onboarding_step. Steps:
// ask_name -> ask_guardian -> ask_codewords -> done. The disclosure (I13) and adults-only notice
// (I15) are sent before the user can plan. No age is ever asked or stored (I15).
import type { E164, InboundMessage, User } from "../contracts.js";
import { parseCodeWordParts, parseSingleCodePhrase, tokenize, validateCodePhrase, validateCodeWords } from "../pipeline/codewords.js";
import { chatTopic } from "../notify/smalltalk.js";
import { captureGuardian, currentGuardianFor } from "./guardian.js";
import { sendTemplate } from "./out.js";
import type { DialoguePorts, DialogueState } from "./ports.js";
import { answerOffScript } from "./smalltalk.js";

export const ONBOARDING_STEPS = ["ask_name", "ask_guardian", "ask_codewords", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function onboardingStep(user: User): OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(user.onboardingStep) ? (user.onboardingStep as OnboardingStep) : "ask_name";
}

/**
 * First message from an unknown address (spec 4.2 trigger). If the first message already
 * introduces the person ("Hi, I'm Robin"), greet them by name and skip the name question
 * instead of asking for something they just said (spec 4.4.3 spirit: never ask for what the
 * user already said).
 */
export async function startOnboarding(ports: DialoguePorts, from: E164, firstText: string | null = null): Promise<string> {
  if (ports.config.allowNewConversation && !(await ports.config.allowNewConversation())) {
    await ports.sendTemplate(from, "quota_onboarding_paused");
    return "onboarding_quota";
  }
  const user = await ports.repo.createUser(from, ports.clock.now());
  const introduced = firstText ? parseIntroducedName(firstText) : null;
  if (introduced) {
    await ports.repo.updateUser(user.id, { displayName: introduced, onboardingStep: "ask_guardian" });
    await sendTemplate(ports, from, "onb_hello", { userName: introduced });
    await sendTemplate(ports, from, "onb_ask_guardian", { quickSetup: true });
    return "onboarding_start_named";
  }
  await ports.repo.updateUser(user.id, { onboardingStep: "ask_name" });
  await sendTemplate(ports, from, "onb_hello");
  await sendTemplate(ports, from, "onb_ask_name");
  return "onboarding_start";
}

const NAME_PREFIX = /^(?:(?:hi|hey|hello|yo|sup)[\s,!.]+)?(?:i'?m|i am|my name is|my name'?s|name'?s|call me|it'?s|this is|you can call me)\s+/i;
const EXPLICIT_INTRO = /^(?:(?:hi|hey|hello|yo|sup|hiya|howdy)(?:\s+there)?[\s,!.]+)?(?:i'?m|i am|my name is|my name'?s|call me|this is|you can call me)\s+\S/i;

/**
 * A name only when the message is an explicit self-introduction ("Hi, I'm Robin", "my name is
 * Robin"). A bare greeting like "hi" or "hey there" is not a name.
 */
export function parseIntroducedName(text: string): string | null {
  const t = text.trim();
  if (!EXPLICIT_INTRO.test(t)) return null;
  const name = parseName(t);
  if (!name) return null;
  // "I'm on a date" or "I'm going out" is not a name.
  if (/^(on|going|at|in|here|good|fine|ok|okay|new|meeting|looking|not|so|just|trying)\b/i.test(name)) return null;
  return name;
}

/** "I'm alex!" -> "Alex". Returns null when the reply does not look like a name. */
export function parseName(text: string): string | null {
  let t = text.trim().replace(/^(?:hi|hey|hello|yo)[\s,!.]+/i, "");
  t = t.replace(NAME_PREFIX, "");
  t = t.replace(/[^\p{L}\p{M}\s'.-]/gu, " ").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (!t || /\d{3,}/.test(text)) return null;
  const words = t.split(" ");
  if (words.length > 3 || t.length > 40) return null;
  return words.map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

export async function sendCodewordsDone(ports: DialoguePorts, to: E164): Promise<void> {
  await sendTemplate(ports, to, "onb_save_contact");
  await ports.shareContactCard(to);
  await sendTemplate(ports, to, "onb_disclosure_done");
}

type Draft = NonNullable<DialogueState["codewordDraft"]>;

async function setDraft(ports: DialoguePorts, user: User, draft: Draft | null): Promise<void> {
  const ds = (await ports.repo.getDialogueState(user.id)) ?? {};
  await ports.repo.setDialogueState(user.id, { ...ds, codewordDraft: draft });
}

async function askOne(ports: DialoguePorts, user: User, step: "exit" | "alert", reasonId: string | null): Promise<void> {
  const cur = await currentGuardianFor(ports, user.id);
  await sendTemplate(ports, user.addressE164, "onb_codeword_ask", { step, reasonId, guardianName: cur?.guardian.displayName ?? null });
}

async function saveCodeWords(
  ports: DialoguePorts,
  user: User,
  words: { exit: string; alert: string },
  opts: { changeOnly: boolean; positional: boolean },
): Promise<void> {
  await ports.repo.setCodeWords(user.id, words);
  await setDraft(ports, user, null);
  // A pair without labels was read as exit first: say which is which (4.2, live feedback).
  if (opts.positional) await sendTemplate(ports, user.addressE164, "onb_codewords_order", { exitWord: words.exit, alertWord: words.alert });
  if (opts.changeOnly) await sendTemplate(ports, user.addressE164, "onb_save_contact", { changeOnly: true });
  else await sendCodewordsDone(ports, user.addressE164);
}

/**
 * Handle the user's code word reply (4.2). Returns true when saved. Shared with "change code
 * words". Common forms are parsed deterministically; when the reply cannot be parsed, Batman asks
 * one at a time ("What's your exit word?" then "And your alert word?") instead of repeating the
 * format. Validation rules are exactly 4.2 (validateCodePhrase / validateCodeWords). Code words
 * never reach the model and are never logged (I8).
 */
export async function handleCodewordReply(ports: DialoguePorts, user: User, text: string, opts: { changeOnly: boolean }): Promise<boolean> {
  const ds = (await ports.repo.getDialogueState(user.id)) ?? {};
  const draft = ds.codewordDraft ?? null;
  const parts = parseCodeWordParts(text);

  // 1. A full pair always wins, in either mode.
  if (parts?.exit && parts.alert) {
    const v = validateCodeWords(parts.exit, parts.alert);
    if (v.ok) {
      await saveCodeWords(ports, user, v.codeWords, { ...opts, positional: parts.positional });
      return true;
    }
    if (v.reason === "format" || v.reason === "word_count") {
      // Most likely a misread, not a bad choice: go one at a time.
      await setDraft(ports, user, { awaiting: "exit", exit: null });
      await askOne(ports, user, "exit", v.reason === "word_count" ? "word_count" : null);
      return false;
    }
    await sendTemplate(ports, user.addressE164, "onb_codewords_invalid", { reasonId: v.reason });
    return false;
  }

  // 2. One labeled word ("exit word is pineapple") or one-at-a-time mode.
  let awaiting: "exit" | "alert" | null = draft?.awaiting ?? null;
  let phrase: string | null = null;
  if (parts && (parts.exit || parts.alert)) {
    awaiting = parts.exit ? "exit" : "alert";
    phrase = parts.exit ?? parts.alert;
  } else if (draft) {
    phrase = parseSingleCodePhrase(text);
  }
  if (!awaiting || !phrase) {
    // Could not tell what this is: switch to one at a time, no format lecture.
    await setDraft(ports, user, { awaiting: draft?.awaiting ?? "exit", exit: draft?.exit ?? null });
    await askOne(ports, user, draft?.awaiting ?? "exit", draft ? "format" : null);
    return false;
  }
  const bad = validateCodePhrase(phrase);
  if (bad) {
    await setDraft(ports, user, { awaiting, exit: awaiting === "alert" ? (draft?.exit ?? null) : null });
    await askOne(ports, user, awaiting, bad);
    return false;
  }
  const normalized = tokenize(phrase).join(" ");
  if (awaiting === "exit") {
    await setDraft(ports, user, { awaiting: "alert", exit: normalized });
    await askOne(ports, user, "alert", null);
    return false;
  }
  const exit = draft?.exit ?? null;
  if (!exit) {
    // Alert word first ("alert: blue moon"): keep it simple and ask for the exit word next.
    await setDraft(ports, user, { awaiting: "exit", exit: null });
    await askOne(ports, user, "exit", null);
    return false;
  }
  const v = validateCodeWords(exit, normalized);
  if (!v.ok) {
    await setDraft(ports, user, { awaiting: "alert", exit });
    await askOne(ports, user, "alert", v.reason);
    return false;
  }
  await saveCodeWords(ports, user, v.codeWords, { ...opts, positional: false });
  return true;
}

/** Continue onboarding for a user who has not finished it. */
export async function handleOnboarding(ports: DialoguePorts, user: User, msg: InboundMessage): Promise<string> {
  const step = onboardingStep(user);
  const to = user.addressE164;
  const c = msg.content;
  switch (step) {
    case "ask_name": {
      // Off-script ("who are you?", "hey"): answer in character, then ask the name again (4.1).
      if (c.kind === "text" && chatTopic(c.text)) {
        await answerOffScript(ports, null, to, null, c.text, "ask_name");
        return "onboarding_smalltalk";
      }
      const name = c.kind === "text" ? parseName(c.text) : null;
      if (!name) {
        await sendTemplate(ports, to, "onb_ask_name");
        return "onboarding_ask_name_again";
      }
      await ports.repo.updateUser(user.id, { displayName: name, onboardingStep: "ask_guardian" });
      await sendTemplate(ports, to, "onb_ask_guardian", { userName: name });
      return "onboarding_name";
    }
    case "ask_guardian": {
      if (c.kind === "voice_unavailable") {
        await sendTemplate(ports, to, "voice_unavailable");
        return "onboarding_voice";
      }
      if (c.kind === "text" && !/\d/.test(c.text) && chatTopic(c.text)) {
        await answerOffScript(ports, user, to, null, c.text, "ask_guardian");
        return "onboarding_smalltalk";
      }
      const ok = await captureGuardian(ports, user, c);
      if (!ok) return "onboarding_guardian_invalid";
      const links = await ports.repo.listLinksForUser(user.id);
      const link = links.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];
      const g = link ? await ports.repo.getGuardian(link.guardianId) : null;
      await ports.repo.updateUser(user.id, { onboardingStep: "ask_codewords" });
      await sendTemplate(ports, to, "onb_ask_codewords", { guardianName: g?.displayName ?? null });
      return "onboarding_guardian";
    }
    case "ask_codewords": {
      if (c.kind === "contact") {
        // The previous backup declined while the user was mid-onboarding: take a new one.
        await captureGuardian(ports, user, c);
        return "onboarding_guardian_replaced";
      }
      if (c.kind !== "text") {
        await sendTemplate(ports, to, "onb_codewords_invalid", { reasonId: "format" });
        return "onboarding_codewords_invalid";
      }
      const saved = await handleCodewordReply(ports, user, c.text, { changeOnly: false });
      if (!saved) return "onboarding_codewords_invalid";
      await ports.repo.updateUser(user.id, { onboardingStep: "done" });
      return "onboarding_done";
    }
    default:
      return "onboarding_already_done";
  }
}
