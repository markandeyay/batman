// Intake (spec 4.4): extract, then at most one follow-up with at most 3 questions, ordered
// start time > venue > duration > counterpart > transport, type-specific questions replacing the
// lowest generic ones. Defaults are stated, not asked. Required fields are asked once more at
// most per round; optional questions are never re-asked. Arming needs an explicit GO (I1).
// One open plan per user; a second plan asks to replace. Edits after arming re-confirm only the
// changed fields.
import type { Plan, PlanType, User } from "../contracts.js";
import { formatClock, formatDayTime } from "../geo/timezone.js";
import { extractPlan, type ExtractOutcome, type PartialPlanFacts } from "../nlu/extractPlan.js";
import { isAffirmative, isGo, isNegative } from "../nlu/rules.js";
import { phraseQuestions, questionItem, type CopyItem, type QuestionId } from "../notify/copy.js";
import { EXTRA_COPY, durationText } from "../notify/templates.js";
import { currentGuardianFor } from "./guardian.js";
import { sendTemplate, sendText } from "./out.js";
import type { DialoguePorts, DialogueState, PlanEditField, PlanFieldPatch } from "./ports.js";

export const DEFAULT_DURATION_MIN: Record<PlanType, number> = { date: 120, marketplace: 20, viewing: 45, other: 60 };
export const MAX_QUESTIONS = 3;

export function graceMinFor(type: PlanType | null): number {
  return type === "marketplace" || type === "viewing" ? 5 : 15;
}

type Intake = NonNullable<DialogueState["intake"]>;

function tzOf(ports: DialoguePorts, user: User): string {
  return user.tz ?? ports.config.defaultTz;
}

function newIntake(planId: string): Intake {
  return { planId, rounds: 0, asked: [], declined: [], defaultsUsed: [], durationMin: null, messages: [] };
}

function factsOf(plan: Plan, intake: Intake | null): PartialPlanFacts {
  const dur =
    intake?.durationMin ?? (plan.startAt && plan.endAt ? Math.round((plan.endAt.getTime() - plan.startAt.getTime()) / 60000) : null);
  return {
    type: plan.type,
    startAt: plan.startAt,
    venueText: plan.venueText,
    durationMin: dur,
    counterpartName: plan.counterpartName,
    counterpartSource: plan.counterpartSource,
    transport: plan.transport,
  };
}

async function saveState(ports: DialoguePorts, user: User, state: DialogueState): Promise<void> {
  await ports.repo.setDialogueState(user.id, state);
}

async function geocodeVenue(ports: DialoguePorts, user: User, venueText: string): Promise<PlanFieldPatch> {
  try {
    const near = user.homeLat !== null && user.homeLng !== null ? { lat: user.homeLat, lng: user.homeLng } : null;
    const r = (await ports.geocoder.geocode(venueText, { near, limit: 3 }))[0];
    if (!r) return { venueLat: null, venueLng: null, venuePlaceType: null };
    return { venueLat: r.lat, venueLng: r.lng, venuePlaceType: r.placeType, ...(r.residential ? { privateAddress: true } : {}) };
  } catch {
    return {};
  }
}

/** Map an extraction onto plan fields. Only non-null values are applied. */
function patchFromExtraction(o: ExtractOutcome, intake: Intake): { patch: PlanFieldPatch; changed: PlanEditField[] } {
  const e = o.extraction;
  const patch: PlanFieldPatch = {};
  const changed: PlanEditField[] = [];
  if (e.type) {
    patch.type = e.type;
    changed.push("type");
  }
  if (e.venueText) {
    patch.venueText = e.venueText.trim().slice(0, 200);
    changed.push("venue");
  }
  if (e.counterpartName) {
    patch.counterpartName = e.counterpartName;
    changed.push("counterpart");
  }
  if (e.counterpartSource) patch.counterpartSource = e.counterpartSource;
  if (e.transport && e.transport !== "unknown") {
    patch.transport = e.transport;
    changed.push("transport");
  }
  if (e.firstTimeInPerson !== null) patch.firstTimeInPerson = e.firstTimeInPerson;
  if (e.buyOrSell) patch.buyOrSell = e.buyOrSell;
  if (e.meetingAtPrivateAddress !== null) patch.privateAddress = e.meetingAtPrivateAddress;
  if (e.userNervous) patch.userNervous = true;
  if (e.durationMin !== null) {
    intake.durationMin = e.durationMin;
    intake.defaultsUsed = intake.defaultsUsed.filter((d) => d !== "duration");
    changed.push("endAt");
  }
  return { patch, changed };
}

/** Questions for the next follow-up (spec 4.4.3 and 4.4.4). */
export function chooseQuestions(plan: Plan, intake: Intake): QuestionId[] {
  const skip = new Set<QuestionId>([...intake.declined]);
  const askedTwice = (id: QuestionId) => intake.asked.filter((a) => a === id).length >= 2;
  const required: QuestionId[] = [];
  if (!plan.startAt && !askedTwice("start_time")) required.push("start_time");
  if (!plan.venueText && !askedTwice("venue")) required.push("venue");
  if (!plan.type && intake.rounds === 0) required.push("type");
  if (intake.rounds > 0) return required.slice(0, MAX_QUESTIONS);
  const typeSpecific: QuestionId[] = [];
  const generic: QuestionId[] = [];
  const asked = new Set(intake.asked);
  const add = (list: QuestionId[], id: QuestionId) => {
    if (!skip.has(id) && !asked.has(id)) list.push(id);
  };
  switch (plan.type) {
    case "date":
      if (plan.firstTimeInPerson === null) add(typeSpecific, "date_first_time");
      if (!plan.counterpartName) add(typeSpecific, "date_name_source");
      break;
    case "marketplace":
      if (!plan.buyOrSell) add(typeSpecific, "mkt_buy_sell");
      if (plan.privateAddress) add(typeSpecific, "mkt_move_public");
      break;
    case "viewing":
      add(typeSpecific, "viewing_agent");
      break;
    case "other":
      if (!plan.counterpartName && intake.durationMin === null) add(typeSpecific, "other_who_how_long");
      break;
    default:
      break;
  }
  if (!plan.counterpartName && plan.type !== "date" && plan.type !== "other") add(generic, "counterpart_name");
  if (!plan.transport) add(generic, "transport");
  // Type-specific questions replace the lowest-priority generic ones.
  return [...required, ...typeSpecific, ...generic].slice(0, MAX_QUESTIONS);
}

function durationStatement(type: PlanType, min: number): string {
  if (type === "marketplace") return `Should take about ${durationText(min)}?`;
  return `I'll assume about ${durationText(min)}, tell me if it's longer.`;
}

function tipFor(plan: Plan, intake: Intake): string | null {
  if (plan.type === "date" && plan.transport === "their_car") return "Maybe keep your own ride home as an option.";
  if (plan.type === "date" && /\b(bar|drinks?|pub|brewery|cocktails?|lounge|club|wine)\b/i.test(`${plan.venueText ?? ""} ${intake.messages.join(" ")}`)) {
    return "Keep your drink with you.";
  }
  if (plan.type === "marketplace" && /\b(cash|\$\s?\d{3,})\b/i.test(intake.messages.join(" "))) return "If it's cash, count it somewhere visible.";
  if (plan.type === "viewing" && /\b(paid|deposit|venmo|zelle|sent (him|her|them) money)\b/i.test(intake.messages.join(" "))) {
    return "Heads up, asking for deposits before a viewing is a common scam.";
  }
  return null;
}

/** Ask the next questions, or send the plan confirmation when nothing required is missing. */
async function nextStep(ports: DialoguePorts, user: User, planId: string, state: DialogueState): Promise<string> {
  const plan = await ports.repo.getPlan(planId);
  const intake = state.intake;
  if (!plan || !intake) return "intake_lost";
  const to = user.addressE164;

  // Type default after one round.
  if (!plan.type && intake.rounds > 0) {
    await ports.repo.updatePlanFields(plan.id, { type: "other" });
    plan.type = "other";
    if (!intake.defaultsUsed.includes("type")) intake.defaultsUsed.push("type");
  }
  if (intake.durationMin === null && plan.type) {
    intake.durationMin = DEFAULT_DURATION_MIN[plan.type];
    if (!intake.defaultsUsed.includes("duration")) intake.defaultsUsed.push("duration");
  }

  const questions = chooseQuestions(plan, intake);
  const missingRequired = !plan.startAt || !plan.venueText;
  if (questions.length > 0 && (missingRequired || intake.rounds === 0)) {
    const items: CopyItem[] = [];
    const reqIds: QuestionId[] = questions.filter((q) => q === "start_time" || q === "venue" || q === "type");
    const optIds = questions.filter((q) => !reqIds.includes(q));
    for (const q of reqIds) items.push(questionItem(q));
    if (intake.rounds === 0 && plan.type && intake.defaultsUsed.includes("duration") && intake.durationMin !== null) {
      items.push({ id: "statement", text: durationStatement(plan.type, intake.durationMin) });
    }
    for (const q of optIds) items.push(questionItem(q));
    const facts = [user.displayName, plan.venueText, plan.counterpartName, plan.counterpartSource].filter((x): x is string => !!x);
    const phrased = await ports.typing(to, () => phraseQuestions(items, facts, ports.llm));
    await sendText(ports, to, phrased.text);
    intake.asked.push(...questions);
    // Optional questions are asked once; never re-ask a declined optional one (4.4.3).
    for (const q of optIds) if (!intake.declined.includes(q)) intake.declined.push(q);
    intake.rounds += 1;
    await saveState(ports, user, { ...state, intake, pending: { kind: "questions", planId: plan.id } });
    return "intake_questions";
  }
  if (missingRequired) {
    // Required fields still missing after two asks: keep asking for exactly those, briefly.
    const items = [!plan.startAt ? questionItem("start_time") : null, !plan.venueText ? questionItem("venue") : null].filter(
      (x): x is CopyItem => x !== null,
    );
    await sendText(ports, to, items.map((i) => i.text).join(" "));
    intake.rounds += 1;
    await saveState(ports, user, { ...state, intake, pending: { kind: "questions", planId: plan.id } });
    return "intake_required_again";
  }
  return sendConfirmation(ports, user, plan, state);
}

async function sendConfirmation(ports: DialoguePorts, user: User, plan: Plan, state: DialogueState): Promise<string> {
  const intake = state.intake ?? newIntake(plan.id);
  const type = plan.type ?? "other";
  const duration = intake.durationMin ?? DEFAULT_DURATION_MIN[type];
  const endAt = plan.startAt ? new Date(plan.startAt.getTime() + duration * 60000) : null;
  const highVigilance = (type === "marketplace" && plan.privateAddress === true) || plan.transport === "their_car" || plan.userNervous;
  const cur = await currentGuardianFor(ports, user.id);
  const patch: PlanFieldPatch = { endAt, graceMin: graceMinFor(type), highVigilance };
  if (cur && plan.guardianId !== cur.guardian.id) patch.guardianId = cur.guardian.id;
  await ports.repo.updatePlanFields(plan.id, patch);
  const updated: Plan = { ...plan, ...patch } as Plan;
  await sendTemplate(ports, user.addressE164, "plan_confirm", {
    plan: updated,
    userName: user.displayName,
    guardianName: cur?.guardian.displayName ?? null,
    tz: tzOf(ports, user),
    defaultsUsed: intake.defaultsUsed,
    durationMin: duration,
    tip: tipFor(updated, intake),
  });
  await saveState(ports, user, { ...state, intake, pending: { kind: "go", planId: plan.id } });
  return "intake_confirm";
}

/** GO after a confirmation: tapback and arm (I1: the only path to an "arm" event). */
async function arm(ports: DialoguePorts, user: User, plan: Plan, messageId: string, state: DialogueState): Promise<string> {
  await ports.react(messageId, "like");
  const cur = await currentGuardianFor(ports, user.id);
  const accepted = cur?.link.status === "accepted" && (plan.guardianId === null || plan.guardianId === cur.guardian.id);
  if (cur && plan.guardianId !== cur.guardian.id) await ports.repo.updatePlanFields(plan.id, { guardianId: cur.guardian.id });
  await saveState(ports, user, { ...state, pending: null, intake: null });
  await ports.dispatch(plan.id, { type: "arm", guardianAccepted: accepted === true });
  return accepted ? "intake_armed" : "intake_awaiting_guardian";
}

async function applyTime(ports: DialoguePorts, user: User, plan: Plan, at: Date, state: DialogueState): Promise<string> {
  if (plan.state === "DRAFT") {
    await ports.repo.updatePlanFields(plan.id, { startAt: at });
    return nextStep(ports, user, plan.id, { ...state, pending: null });
  }
  return applyArmedEdit(ports, user, plan, { startAt: at }, ["startAt"], state);
}

/** Edits after arming (4.4.6): update, tell the engine, confirm only the changed fields. */
async function applyArmedEdit(
  ports: DialoguePorts,
  user: User,
  plan: Plan,
  patch: PlanFieldPatch,
  fields: PlanEditField[],
  state: DialogueState,
): Promise<string> {
  const tz = tzOf(ports, user);
  const full: PlanFieldPatch = { ...patch };
  const changes: string[] = [];
  if (patch.startAt && plan.startAt && plan.endAt) {
    const dur = plan.endAt.getTime() - plan.startAt.getTime();
    full.endAt = new Date(patch.startAt.getTime() + dur);
    changes.push(`now ${formatDayTime(patch.startAt, tz)}`);
    if (!fields.includes("endAt")) fields.push("endAt");
  }
  if (patch.endAt && !patch.startAt) changes.push(`back by about ${formatClock(patch.endAt, tz)}`);
  if (patch.venueText) {
    Object.assign(full, await geocodeVenue(ports, user, patch.venueText));
    changes.push(`meeting at ${patch.venueText}`);
  }
  if (patch.transport) changes.push("ride noted");
  if (patch.counterpartName) changes.push(`meeting ${patch.counterpartName}`);
  await ports.repo.updatePlanFields(plan.id, full);
  await ports.dispatch(plan.id, { type: "plan_edited", fields });
  await sendTemplate(ports, user.addressE164, "plan_edit_confirm", { changes }, { planState: plan.state });
  await saveState(ports, user, { ...state, pending: null });
  return "intake_edit";
}

function looksLikeNewPlan(o: ExtractOutcome, plan: Plan): boolean {
  const e = o.extraction;
  if (e.wantsToChange.length > 0) return false;
  const t = o.time.startAt;
  const timeDiffers = t !== null && plan.startAt !== null && Math.abs(t.getTime() - plan.startAt.getTime()) > 3600_000;
  const venueDiffers = !!e.venueText && !!plan.venueText && e.venueText.toLowerCase() !== plan.venueText.toLowerCase();
  const typeDiffers = !!e.type && !!plan.type && e.type !== plan.type;
  return (timeDiffers && (venueDiffers || typeDiffers || !!e.venueText)) || (typeDiffers && venueDiffers);
}

function extractedSomething(o: ExtractOutcome): boolean {
  const e = o.extraction;
  return !!(e.type || o.time.startAt || e.venueText || e.counterpartName || e.durationMin);
}

/**
 * Handle intake-related text from an onboarded user whose plan is DRAFT, ARMED,
 * AWAITING_GUARDIAN, or PRE_MEETUP, or who has no plan. Returns a route label.
 */
export async function handleIntakeText(ports: DialoguePorts, user: User, plan: Plan | null, msg: { id: string; text: string }): Promise<string> {
  const tz = tzOf(ports, user);
  const now = ports.clock.now();
  const state: DialogueState = (await ports.repo.getDialogueState(user.id)) ?? {};

  // Pending yes/no contexts first.
  const p = state.pending;
  if (p?.kind === "go" && plan && plan.id === p.planId && plan.state === "DRAFT" && isGo(msg.text)) {
    return arm(ports, user, plan, msg.id, state);
  }
  if ((p?.kind === "time_confirm" || p?.kind === "time_past") && plan && plan.id === p.planId) {
    if (isAffirmative(msg.text)) return applyTime(ports, user, plan, new Date(p.proposed), { ...state, pending: null });
    if (isNegative(msg.text)) {
      await sendText(ports, user.addressE164, EXTRA_COPY.ask_time_again());
      await saveState(ports, user, { ...state, pending: null });
      return "intake_time_rejected";
    }
  }
  if (p?.kind === "replace") {
    if (isAffirmative(msg.text)) {
      const old = await ports.repo.getPlan(p.planId);
      await saveState(ports, user, {});
      if (old) await ports.dispatch(old.id, { type: "user_command", command: "cancel" });
      return startNewPlan(ports, user, p.text, tz, now);
    }
    if (isNegative(msg.text)) {
      await saveState(ports, user, { ...state, pending: null });
      await sendText(ports, user.addressE164, EXTRA_COPY.replace_kept());
      return "intake_replace_kept";
    }
  }

  if (!plan) return startNewPlan(ports, user, msg.text, tz, now);

  const intake = state.intake && state.intake.planId === plan.id ? state.intake : plan.state === "DRAFT" ? newIntake(plan.id) : null;
  const history = intake ? [...intake.messages.slice(-3), msg.text] : [msg.text];
  const outcome = await ports.typing(user.addressE164, () =>
    extractPlan({ messages: history, partial: factsOf(plan, intake), now, tz }, ports.llm),
  );

  if (plan.state !== "DRAFT") {
    // Armed or awaiting guardian: an edit, a new plan, or chatter.
    if (looksLikeNewPlan(outcome, plan)) {
      await saveState(ports, user, { ...state, pending: { kind: "replace", planId: plan.id, text: msg.text } });
      await sendTemplate(ports, user.addressE164, "plan_replace_ask", { plan, tz }, { planState: plan.state });
      return "intake_replace_ask";
    }
    const scratch = newIntake(plan.id);
    const { patch, changed } = patchFromExtraction(outcome, scratch);
    const edits: PlanFieldPatch = {};
    const fields: PlanEditField[] = [];
    const wants = new Set(outcome.extraction.wantsToChange);
    if (outcome.time.startAt && (wants.has("startAt") || wants.size === 0) && (!plan.startAt || Math.abs(outcome.time.startAt.getTime() - plan.startAt.getTime()) > 60000)) {
      if (outcome.time.needsConfirmation || outcome.time.inPast) {
        const proposed = (outcome.time.inPast ? outcome.time.suggestedStart : outcome.time.startAt) ?? outcome.time.startAt;
        await saveState(ports, user, { ...state, pending: { kind: outcome.time.inPast ? "time_past" : "time_confirm", planId: plan.id, proposed: proposed.toISOString() } });
        await sendTemplate(ports, user.addressE164, outcome.time.inPast ? "plan_time_past_ask" : "plan_time_confirm_ask", { suggestedStart: proposed, tz }, { planState: plan.state });
        return "intake_edit_time_confirm";
      }
      edits.startAt = outcome.time.startAt;
      fields.push("startAt");
    }
    if (patch.venueText && changed.includes("venue") && patch.venueText !== plan.venueText) {
      edits.venueText = patch.venueText;
      fields.push("venue");
    }
    if (scratch.durationMin !== null && plan.startAt) {
      edits.endAt = new Date((edits.startAt ?? plan.startAt).getTime() + scratch.durationMin * 60000);
      fields.push("endAt");
    }
    if (patch.transport && patch.transport !== plan.transport) {
      edits.transport = patch.transport;
      fields.push("transport");
    }
    if (fields.length === 0) {
      await sendTemplate(ports, user.addressE164, "status", { plan, state: plan.state, tz }, { planState: plan.state });
      return "intake_status";
    }
    return applyArmedEdit(ports, user, plan, edits, fields, state);
  }

  // DRAFT
  const live = intake ?? newIntake(plan.id);
  live.messages = [...live.messages, msg.text].slice(-5);
  return applyToDraft(ports, user, plan, outcome, { ...state, intake: live });
}

async function startNewPlan(ports: DialoguePorts, user: User, text: string, tz: string, now: Date): Promise<string> {
  const outcome = await ports.typing(user.addressE164, () => extractPlan({ messages: [text], partial: null, now, tz }, ports.llm));
  if (!extractedSomething(outcome)) {
    await sendTemplate(ports, user.addressE164, "help");
    return "intake_nothing";
  }
  const cur = await currentGuardianFor(ports, user.id);
  const plan = await ports.repo.createDraftPlan(user.id, { guardianId: cur?.guardian.id ?? null }, now);
  const intake = newIntake(plan.id);
  intake.messages = [text];
  return applyToDraft(ports, user, plan, outcome, { pending: null, intake });
}

async function applyToDraft(ports: DialoguePorts, user: User, plan: Plan, outcome: ExtractOutcome, state: DialogueState): Promise<string> {
  const intake = state.intake!;
  const { patch } = patchFromExtraction(outcome, intake);
  if (patch.venueText && patch.venueText !== plan.venueText) Object.assign(patch, await geocodeVenue(ports, user, patch.venueText));
  const t = outcome.time;
  if (t.startAt && (!plan.startAt || Math.abs(t.startAt.getTime() - plan.startAt.getTime()) > 60000)) {
    if (t.needsConfirmation || t.inPast) {
      await ports.repo.updatePlanFields(plan.id, patch);
      const proposed = (t.inPast ? t.suggestedStart : t.startAt) ?? t.startAt;
      await saveState(ports, user, { ...state, pending: { kind: t.inPast ? "time_past" : "time_confirm", planId: plan.id, proposed: proposed.toISOString() } });
      await sendTemplate(ports, user.addressE164, t.inPast ? "plan_time_past_ask" : "plan_time_confirm_ask", {
        suggestedStart: proposed,
        tz: tzOf(ports, user),
      });
      return t.inPast ? "intake_time_past" : "intake_time_confirm";
    }
    patch.startAt = t.startAt;
  }
  await ports.repo.updatePlanFields(plan.id, patch);
  return nextStep(ports, user, plan.id, state);
}

/** A location with coordinates (e.g. a Maps link the gateway parsed) while planning: the venue. */
export async function handleIntakeLocation(ports: DialoguePorts, user: User, plan: Plan, lat: number, lng: number): Promise<string> {
  const state: DialogueState = (await ports.repo.getDialogueState(user.id)) ?? {};
  const address = await ports.geocoder.reverse(lat, lng).catch(() => null);
  const patch: PlanFieldPatch = { venueLat: lat, venueLng: lng, venueText: plan.venueText ?? address ?? "the spot you sent" };
  if (plan.state !== "DRAFT") return applyArmedEdit(ports, user, plan, patch, ["venue"], state);
  await ports.repo.updatePlanFields(plan.id, patch);
  return nextStep(ports, user, plan.id, { ...state, intake: state.intake ?? newIntake(plan.id) });
}

/** True while intake is waiting for a venue (pins without coordinates get loc_pin_unsupported). */
export async function isAwaitingVenue(ports: DialoguePorts, user: User, plan: Plan | null): Promise<boolean> {
  if (!plan || plan.state !== "DRAFT") return false;
  if (!plan.venueText || plan.venueLat === null) return true;
  const state = await ports.repo.getDialogueState(user.id);
  return state?.intake?.asked.includes("venue") === true || state?.intake?.asked.includes("venue_pin") === true;
}
