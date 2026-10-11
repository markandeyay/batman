// Outbound helpers for dialogue-originated messages. Two guards on every send:
// I14: nothing goes to an address that sent STOP (except the single stop_ack, sent before the flag).
// I10: while the user's plan is in a DISCREET_STATE, only DISCREET_TEMPLATES may go to the user,
//      and free text must pass the banned-word filter.
import type { E164, PlanState, SentRef, TemplateId } from "../contracts.js";
import { DISCREET_STATES } from "../contracts.js";
import { isDiscreet } from "../notify/discretion.js";
import { canSendInState, type TemplateParams } from "../notify/templates.js";
import type { DialoguePorts } from "./ports.js";

export async function sendTemplate(
  ports: DialoguePorts,
  to: E164,
  template: TemplateId,
  params: TemplateParams = {},
  ctx: { planState?: PlanState | null } = {},
): Promise<SentRef | null> {
  if (await ports.repo.isStopped(to)) {
    ports.log?.info("send_dropped_stopped", { template });
    return null;
  }
  if (!canSendInState(template, ctx.planState ?? null)) {
    ports.log?.warn("send_blocked_discretion", { template, state: ctx.planState ?? null });
    return null;
  }
  return ports.sendTemplate(to, template, params);
}

export async function sendText(
  ports: DialoguePorts,
  to: E164,
  text: string,
  ctx: { planState?: PlanState | null } = {},
): Promise<SentRef | null> {
  if (!text.trim()) return null;
  if (await ports.repo.isStopped(to)) return null;
  if (ctx.planState && DISCREET_STATES.includes(ctx.planState) && !isDiscreet(text)) {
    ports.log?.warn("text_blocked_discretion", { state: ctx.planState });
    return null;
  }
  return ports.sendText(to, text);
}
