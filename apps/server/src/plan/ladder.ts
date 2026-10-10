// Escalation ladder timings and step progression (spec 6.4, 7.3, 7.4, 7.6). Pure.
import type { LadderClass, LadderStep, Plan, TemplateId, TriggerId } from "../contracts.js";

export const MIN_MS = 60_000;

/** Default timings in minutes (6.4). T1 is the wait after L0, T2 after L1, T3 after L2. */
export const LADDER_TIMINGS: Readonly<Record<LadderClass, { T1: number | null; T2: number; T3: number }>> = {
  overtime: { T1: 10, T2: 5, T3: 3 },
  soft: { T1: 5, T2: 4, T3: 3 },
  hard: { T1: 3, T2: 2, T3: 2 },
  guardian_requested: { T1: null, T2: 0, T3: 3 },
};

export const NIGHT_MULTIPLIER = 0.7;
export const HIGH_VIGILANCE_MULTIPLIER = 0.6;

/** Night (22:00 to 05:00 local) x0.7 and high vigilance x0.6; both apply when both hold. */
export function ladderMultiplier(opts: { night: boolean; highVigilance: boolean }): number {
  return (opts.night ? NIGHT_MULTIPLIER : 1) * (opts.highVigilance ? HIGH_VIGILANCE_MULTIPLIER : 1);
}

export function nextStep(step: LadderStep | null): LadderStep | null {
  switch (step) {
    case null:
      return "L0";
    case "L0":
      return "L1";
    case "L1":
      return "L2";
    case "L2":
      return "L3";
    default:
      return null;
  }
}

export function prevStep(step: LadderStep): LadderStep | null {
  switch (step) {
    case "L1":
      return "L0";
    case "L2":
      return "L1";
    case "L3":
      return "L2";
    default:
      return null;
  }
}

/**
 * Wait before taking `step` (measured from when the previous step was taken), in ms.
 * L1 waits T1, L2 waits T2, L3 waits T3. A class without T1 (guardian-requested) uses T2.
 */
export function stepDelayMs(cls: LadderClass, step: "L1" | "L2" | "L3", multiplier: number): number {
  const t = LADDER_TIMINGS[cls];
  const minutes = step === "L1" ? (t.T1 ?? t.T2) : step === "L2" ? t.T2 : t.T3;
  return Math.round(minutes * MIN_MS * multiplier);
}

/** Order used for class upgrades: a higher rank has shorter timers (7.3 suppression rules). */
export const CLASS_RANK: Readonly<Record<LadderClass, number>> = {
  overtime: 0,
  soft: 1,
  guardian_requested: 2,
  hard: 3,
};

export function isUpgrade(current: LadderClass | null, incoming: LadderClass): boolean {
  return current === null || CLASS_RANK[incoming] > CLASS_RANK[current];
}

export type TriggerClass = LadderClass | "info";

/** Trigger to class (7.3). T-VENUE-CHG is informational until unanswered for 15 min. */
export const TRIGGER_CLASS: Readonly<Record<TriggerId, TriggerClass>> = {
  "T-OVR": "overtime",
  "T-DEP-WALK": "soft",
  "T-DEP-CAR": "hard",
  "T-DEP-CAR-THEIRS": "hard",
  "T-FAR": "hard",
  "T-DARK": "hard",
  "T-NOARRIVE": "soft",
  "T-MKT-LONG": "soft",
  "T-VENUE-CHG": "info",
  "T-POST-EXIT": "soft",
};

/** L0 copy (7.6). The renderer rotates variants within a template. */
export function l0Template(trigger: TriggerId | null, cls: LadderClass): TemplateId {
  if (trigger === "T-OVR") return "ot_overtime";
  if (trigger === "T-NOARRIVE") return "lad_l0_noarrive";
  if (trigger === "T-POST-EXIT") return "lad_l0_post_exit";
  return cls === "hard" ? "lad_l0_hard" : "lad_l0_soft";
}

/**
 * Plan-level high vigilance (7.4): marketplace at a private address, the counterpart is
 * driving the user, or the user said they are nervous. Night hours are applied separately
 * through NIGHT_MULTIPLIER at timer time. "Viewing where nobody else will be there" has no
 * plan field yet; callers set plan.highVigilance directly for it.
 */
export function computeHighVigilance(p: Pick<Plan, "type" | "privateAddress" | "transport" | "userNervous" | "highVigilance">): boolean {
  if (p.highVigilance) return true;
  if (p.type === "marketplace" && p.privateAddress === true) return true;
  if (p.transport === "their_car") return true;
  if (p.userNervous) return true;
  return false;
}

/** Default grace before overtime (4.7): 5 min marketplace/viewing, 15 min date/other. */
export function defaultGraceMin(type: Plan["type"]): number {
  return type === "marketplace" || type === "viewing" ? 5 : 15;
}

/** Default duration by type (4.4.1), minutes. */
export function defaultDurationMin(type: Plan["type"]): number {
  switch (type) {
    case "date":
      return 120;
    case "marketplace":
      return 20;
    case "viewing":
      return 45;
    default:
      return 60;
  }
}

/** Implicit extensions (OK replies in overtime) are capped at 4 hours in total (4.7). */
export const MAX_IMPLICIT_EXTENSION_MIN = 240;
export const DEFAULT_EXTENSION_MIN = 30;
/** Same-trigger suppression after a user OK (7.3). */
export const SUPPRESS_AFTER_OK_MS = 20 * MIN_MS;
