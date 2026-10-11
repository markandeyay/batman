// New plan records (spec 4.4). A draft expires after 12 h (6.1).
import type { Effect, LocationMode, Plan, PlanType, Transport } from "../contracts.js";
import { DRAFT_TTL_MS } from "./stateMachine.js";
import { defaultDurationMin, defaultGraceMin } from "./ladder.js";
import { newEnginePlan, type EnginePlan } from "./types.js";

export interface DraftInput {
  id: string;
  userId: string;
  guardianId: string | null;
  now: Date;
  type?: PlanType | null;
  startAt?: Date | null;
  /** Planned end; derived from startAt + durationMin (or the type default) when absent. */
  endAt?: Date | null;
  durationMin?: number | null;
  graceMin?: number;
  venueText?: string | null;
  venueLat?: number | null;
  venueLng?: number | null;
  venuePlaceType?: string | null;
  counterpartName?: string | null;
  counterpartSource?: string | null;
  transport?: Transport | null;
  firstTimeInPerson?: boolean | null;
  buyOrSell?: "buy" | "sell" | null;
  privateAddress?: boolean | null;
  userNervous?: boolean;
  highVigilance?: boolean;
  notifyGuardianStartEnd?: boolean;
  locationMode?: LocationMode;
}

export function newDraftPlan(input: DraftInput): { plan: EnginePlan; effects: Effect[] } {
  const type = input.type ?? null;
  const startAt = input.startAt ?? null;
  const endAt =
    input.endAt ?? (startAt ? new Date(startAt.getTime() + (input.durationMin ?? defaultDurationMin(type)) * 60_000) : null);
  const base: Plan = {
    id: input.id,
    userId: input.userId,
    guardianId: input.guardianId,
    state: "DRAFT",
    type,
    startAt,
    endAt,
    graceMin: input.graceMin ?? defaultGraceMin(type),
    venueText: input.venueText ?? null,
    venueLat: input.venueLat ?? null,
    venueLng: input.venueLng ?? null,
    venuePlaceType: input.venuePlaceType ?? null,
    counterpartName: input.counterpartName ?? null,
    counterpartSource: input.counterpartSource ?? null,
    transport: input.transport ?? null,
    firstTimeInPerson: input.firstTimeInPerson ?? (type === "date" ? true : null),
    buyOrSell: input.buyOrSell ?? null,
    privateAddress: input.privateAddress ?? null,
    userNervous: input.userNervous ?? false,
    highVigilance: input.highVigilance ?? false,
    notifyGuardianStartEnd: input.notifyGuardianStartEnd ?? false,
    locationMode: input.locationMode ?? "findmy",
    ladderStep: null,
    ladderClass: null,
    ladderTrigger: null,
    ladderStartedAt: null,
    escalatedAt: null,
    escalationReason: null,
    guardianAckAt: null,
    arrivedAt: null,
    arrivalLineSent: false,
    totalExtensionMin: 0,
    suppressedUntil: {},
    exitWordAt: null,
    closedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const plan = newEnginePlan(base);
  const effects: Effect[] = [
    { kind: "schedule", job: { kind: "draft_expire", runAt: new Date(input.now.getTime() + DRAFT_TTL_MS), planId: plan.id } },
  ];
  return { plan, effects };
}
