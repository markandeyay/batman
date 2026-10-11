// Onboarding (spec 4.2). Resumable: the step lives in users.onboarding_step. Steps:
// ask_name -> ask_guardian -> ask_codewords -> done. The disclosure (I13) and adults-only notice
// (I15) are sent before the user can plan. No age is ever asked or stored (I15).
import type { E164, InboundMessage, User } from "../contracts.js";
import { parseCodeWordReply, validateCodeWords } from "../pipeline/codewords.js";
import { captureGuardian } from "./guardian.js";
import { sendTemplate } from "./out.js";
import type { DialoguePorts } from "./ports.js";

export const ONBOARDING_STEPS = ["ask_name", "ask_guardian", "ask_codewords", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function onboardingStep(user: User): OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(user.onboardingStep) ? (user.onboardingStep as OnboardingStep) : "ask_name";
}

/** First message from an unknown address (spec 4.2 trigger). */
export async function startOnboarding(ports: DialoguePorts, from: E164): Promise<string> {
  if (ports.config.allowNewConversation && !(await ports.config.allowNewConversation())) {
    await ports.sendTemplate(from, "quota_onboarding_paused");
    return "onboarding_quota";
  }
  const user = await ports.repo.createUser(from, ports.clock.now());
  await ports.repo.updateUser(user.id, { onboardingStep: "ask_name" });
  await sendTemplate(ports, from, "onb_hello");
  await sendTemplate(ports, from, "onb_ask_name");
  return "onboarding_start";
}

const NAME_PREFIX = /^(?:(?:hi|hey|hello|yo|sup)[\s,!.]+)?(?:i'?m|i am|my name is|my name'?s|name'?s|call me|it'?s|this is|you can call me)\s+/i;

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

/** Handle the user's codeword reply. Returns true when saved. Shared with "change code words". */
export async function handleCodewordReply(ports: DialoguePorts, user: User, text: string, opts: { changeOnly: boolean }): Promise<boolean> {
  const parsed = parseCodeWordReply(text);
  if (!parsed) {
    await sendTemplate(ports, user.addressE164, "onb_codewords_invalid", { reasonId: "format" });
    return false;
  }
  const v = validateCodeWords(parsed.exit, parsed.alert);
  if (!v.ok) {
    await sendTemplate(ports, user.addressE164, "onb_codewords_invalid", { reasonId: v.reason });
    return false;
  }
  await ports.repo.setCodeWords(user.id, v.codeWords);
  if (opts.changeOnly) await sendTemplate(ports, user.addressE164, "onb_save_contact", { changeOnly: true });
  else await sendCodewordsDone(ports, user.addressE164);
  return true;
}

/** Continue onboarding for a user who has not finished it. */
export async function handleOnboarding(ports: DialoguePorts, user: User, msg: InboundMessage): Promise<string> {
  const step = onboardingStep(user);
  const to = user.addressE164;
  const c = msg.content;
  switch (step) {
    case "ask_name": {
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
