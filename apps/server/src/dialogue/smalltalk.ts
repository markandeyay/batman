// Off-script replies outside windows (spec 4.1, 9.4): acknowledge what the person said in one
// short in-character line, then steer back to the pending step with one fixed line.
// Callers guarantee: never in DISCREET_STATES (out.ts also blocks it), never during code word
// entry, and only after the deterministic code word pass (I8: code words never reach the model).
import type { Plan, TemplateParams, User } from "../contracts.js";
import { DISCREET_STATES } from "../contracts.js";
import { describePlan } from "../notify/templates.js";
import { chatTopic, smallTalkReply, type SmallTalkStep } from "../notify/smalltalk.js";
import { currentGuardianFor } from "./guardian.js";
import { sendTemplate, sendText } from "./out.js";
import type { DialoguePorts } from "./ports.js";

export interface OffScriptOpts {
  /** Extra params for the steer line (questionsText for "questions", plan for "armed"). */
  steer?: TemplateParams;
  /** Skip the steer line (the caller sends its own). */
  noSteer?: boolean;
}

/**
 * Answer an off-script message and steer back. Returns true when an answer (model or fixed)
 * was sent, false when only the steer line went out.
 */
export async function answerOffScript(
  ports: DialoguePorts,
  user: User | null,
  to: User["addressE164"],
  plan: Plan | null,
  text: string,
  step: SmallTalkStep,
  opts: OffScriptOpts = {},
): Promise<boolean> {
  const state = plan?.state ?? null;
  if (state && DISCREET_STATES.includes(state)) return false; // I10: never small talk in a window
  const ctx = { planState: state };
  const cur = user ? await currentGuardianFor(ports, user.id) : null;
  const guardianName = cur?.guardian.displayName ?? null;
  const tz = user?.tz ?? ports.config.defaultTz;
  const planLine = plan && plan.startAt ? describePlan({ plan, tz }) : null;
  const r = await ports.typing(to, () =>
    smallTalkReply(
      {
        message: text,
        step,
        facts: { userName: user?.displayName ?? null, guardianName, counterpartName: plan?.counterpartName ?? null, other: planLine ? [planLine] : [] },
      },
      ports.llm,
      // Reasons only (never the text): banned words, length, grounding, comics.
      { onReject: (reasons) => ports.log?.info("smalltalk_rejected", { step, reasons }) },
    ),
  );
  let answered = false;
  if (r) {
    answered = (await sendText(ports, to, r.text, ctx)) !== null;
    ports.log?.info("smalltalk", { source: "model", step });
  }
  if (!answered) {
    const topic = chatTopic(text);
    if (topic && topic !== "question") {
      await sendTemplate(ports, to, "smalltalk_reply", { reasonId: topic, guardianName }, ctx);
      answered = true;
    }
    ports.log?.info("smalltalk", { source: answered ? "template" : "none", step });
  }
  if (!opts.noSteer) {
    if (step === "confirm") await sendTemplate(ports, to, "plan_go_nudge", {}, ctx);
    else await sendTemplate(ports, to, "smalltalk_steer", { step, guardianName, tz, ...(plan ? { plan } : {}), ...(opts.steer ?? {}) }, ctx);
  }
  return answered;
}
