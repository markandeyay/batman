// Typed data access (spec 12). Returns contracts.ts / plan/types.ts shapes; callers never see rows.
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, notInArray } from "drizzle-orm";
import {
  TERMINAL_STATES,
  type DecoyCaller,
  type E164,
  type EscalationReason,
  type Fix,
  type Guardian,
  type GuardianLinkStatus,
  type LadderClass,
  type LadderStep,
  type LocationMode,
  type PlanState,
  type PlanType,
  type Transport,
  type TriggerId,
  type User,
} from "../contracts.js";
import { DEFAULT_FLAGS, type EnginePlan, type PendingSpot, type PlanFlags } from "../plan/types.js";
import type { Store } from "./db.js";
import * as s from "./schema.js";

export function newId(): string {
  return randomUUID();
}

// ---------- code words ----------

/**
 * Normalization used to store code phrases (spec 9.1): Unicode NFKC, lowercase, strip
 * punctuation and emoji, collapse whitespace. pipeline/codewords.ts applies the same rules
 * to inbound text; keep them identical.
 */
export function normalizePhrase(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashPhrase(userId: string, normalized: string): string {
  return createHash("sha256").update(`${userId}:${normalized}`).digest("hex");
}

// ---------- users ----------

type UserRow = typeof s.users.$inferSelect;

function toUser(r: UserRow): User {
  return {
    id: r.id,
    addressE164: r.addressE164 as E164,
    displayName: r.displayName,
    tz: r.tz,
    onboardingStep: r.onboardingStep,
    decoyCaller: r.decoyCaller,
    homeLat: r.homeLat,
    homeLng: r.homeLng,
    createdAt: r.createdAt,
    deletedAt: r.deletedAt,
  };
}

export function createUser(
  st: Store,
  input: { addressE164: E164; displayName?: string | null; tz?: string | null; onboardingStep?: string; now: Date; id?: string },
): User {
  const row: typeof s.users.$inferInsert = {
    id: input.id ?? newId(),
    addressE164: input.addressE164,
    displayName: input.displayName ?? null,
    tz: input.tz ?? null,
    onboardingStep: input.onboardingStep ?? "new",
    createdAt: input.now,
  };
  st.db.insert(s.users).values(row).run();
  return getUser(st, row.id)!;
}

export function getUser(st: Store, id: string): User | null {
  const r = st.db.select().from(s.users).where(eq(s.users.id, id)).get();
  return r ? toUser(r) : null;
}

export function getUserByAddress(st: Store, address: E164): User | null {
  const r = st.db.select().from(s.users).where(eq(s.users.addressE164, address)).get();
  return r ? toUser(r) : null;
}

export interface UserPatch {
  displayName?: string | null;
  tz?: string | null;
  onboardingStep?: string;
  decoyCaller?: DecoyCaller;
  homeLat?: number | null;
  homeLng?: number | null;
  replyWithVoice?: boolean;
}

export function updateUser(st: Store, id: string, patch: UserPatch): User | null {
  const set: Partial<typeof s.users.$inferInsert> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  if (Object.keys(set).length > 0) st.db.update(s.users).set(set).where(eq(s.users.id, id)).run();
  return getUser(st, id);
}

/** Store code phrases hashed plus normalized (spec 12). Never log the inputs. */
export function setCodeWords(st: Store, userId: string, exitPhrase: string, alertPhrase: string): void {
  const exitNorm = normalizePhrase(exitPhrase);
  const alertNorm = normalizePhrase(alertPhrase);
  st.db
    .update(s.users)
    .set({
      exitPhraseNorm: exitNorm,
      exitPhraseHash: hashPhrase(userId, exitNorm),
      alertPhraseNorm: alertNorm,
      alertPhraseHash: hashPhrase(userId, alertNorm),
    })
    .where(eq(s.users.id, userId))
    .run();
}

export function getCodeWords(st: Store, userId: string): { exit: string; alert: string } | null {
  const r = st.db
    .select({ e: s.users.exitPhraseNorm, a: s.users.alertPhraseNorm })
    .from(s.users)
    .where(eq(s.users.id, userId))
    .get();
  if (!r || !r.e || !r.a) return null;
  return { exit: r.e, alert: r.a };
}

/** True if `phrase` normalizes to the user's stored exit or alert phrase (hash comparison). */
export function codeWordHashMatches(st: Store, userId: string, phrase: string): "exit" | "alert" | null {
  const r = st.db
    .select({ e: s.users.exitPhraseHash, a: s.users.alertPhraseHash })
    .from(s.users)
    .where(eq(s.users.id, userId))
    .get();
  if (!r) return null;
  const h = hashPhrase(userId, normalizePhrase(phrase));
  if (h === r.a) return "alert";
  if (h === r.e) return "exit";
  return null;
}

/**
 * "delete my data" (spec 4.9): removes the user, their plans (cascading to events, fixes),
 * consent records, their jobs, and message log rows. Guardians shared with other users stay.
 */
export function deleteUserData(st: Store, userId: string): void {
  st.sqlite.transaction(() => {
    const user = getUser(st, userId);
    const planIds = st.db.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.userId, userId)).all().map((p) => p.id);
    if (planIds.length > 0) {
      st.db.delete(s.jobs).where(inArray(s.jobs.planId, planIds)).run();
      st.db.delete(s.messages).where(inArray(s.messages.planId, planIds)).run();
    }
    if (user) st.db.delete(s.messages).where(eq(s.messages.addressE164, user.addressE164)).run();
    st.db.delete(s.users).where(eq(s.users.id, userId)).run();
  })();
}

// ---------- guardians ----------

type GuardianRow = typeof s.guardians.$inferSelect;

function toGuardian(r: GuardianRow): Guardian {
  return {
    id: r.id,
    addressE164: r.addressE164 as E164,
    displayName: r.displayName,
    createdAt: r.createdAt,
    stoppedAt: r.stoppedAt,
  };
}

/** Find by address or create. Updates the display name if a new one is given. */
export function upsertGuardian(st: Store, input: { addressE164: E164; displayName?: string | null; now: Date }): Guardian {
  const existing = getGuardianByAddress(st, input.addressE164);
  if (existing) {
    if (input.displayName && input.displayName !== existing.displayName) {
      st.db.update(s.guardians).set({ displayName: input.displayName }).where(eq(s.guardians.id, existing.id)).run();
    }
    return getGuardian(st, existing.id)!;
  }
  const id = newId();
  st.db
    .insert(s.guardians)
    .values({ id, addressE164: input.addressE164, displayName: input.displayName ?? null, createdAt: input.now })
    .run();
  return getGuardian(st, id)!;
}

export function getGuardian(st: Store, id: string): Guardian | null {
  const r = st.db.select().from(s.guardians).where(eq(s.guardians.id, id)).get();
  return r ? toGuardian(r) : null;
}

export function getGuardianByAddress(st: Store, address: E164): Guardian | null {
  const r = st.db.select().from(s.guardians).where(eq(s.guardians.addressE164, address)).get();
  return r ? toGuardian(r) : null;
}

/** Guardian texted STOP (I14). Also revokes every link. */
export function markGuardianStopped(st: Store, guardianId: string, now: Date): void {
  st.sqlite.transaction(() => {
    st.db.update(s.guardians).set({ stoppedAt: now }).where(eq(s.guardians.id, guardianId)).run();
    st.db
      .update(s.userGuardians)
      .set({ status: "revoked", respondedAt: now })
      .where(and(eq(s.userGuardians.guardianId, guardianId), eq(s.userGuardians.status, "accepted")))
      .run();
  })();
}

// ---------- user_guardians ----------

export interface GuardianLink {
  userId: string;
  guardianId: string;
  status: GuardianLinkStatus;
  requestedAt: Date;
  respondedAt: Date | null;
}

export function setGuardianLink(
  st: Store,
  input: { userId: string; guardianId: string; status: GuardianLinkStatus; now: Date },
): GuardianLink {
  const existing = getGuardianLink(st, input.userId, input.guardianId);
  if (existing) {
    st.db
      .update(s.userGuardians)
      .set({
        status: input.status,
        ...(input.status === "pending" ? { requestedAt: input.now, respondedAt: null } : { respondedAt: input.now }),
      })
      .where(and(eq(s.userGuardians.userId, input.userId), eq(s.userGuardians.guardianId, input.guardianId)))
      .run();
  } else {
    st.db
      .insert(s.userGuardians)
      .values({
        userId: input.userId,
        guardianId: input.guardianId,
        status: input.status,
        requestedAt: input.now,
        respondedAt: input.status === "pending" ? null : input.now,
      })
      .run();
  }
  return getGuardianLink(st, input.userId, input.guardianId)!;
}

export function getGuardianLink(st: Store, userId: string, guardianId: string): GuardianLink | null {
  const r = st.db
    .select()
    .from(s.userGuardians)
    .where(and(eq(s.userGuardians.userId, userId), eq(s.userGuardians.guardianId, guardianId)))
    .get();
  return r ?? null;
}

export function listGuardianLinksForUser(st: Store, userId: string): GuardianLink[] {
  return st.db.select().from(s.userGuardians).where(eq(s.userGuardians.userId, userId)).orderBy(desc(s.userGuardians.requestedAt)).all();
}

export function listGuardianLinksForGuardian(st: Store, guardianId: string): GuardianLink[] {
  return st.db
    .select()
    .from(s.userGuardians)
    .where(eq(s.userGuardians.guardianId, guardianId))
    .orderBy(desc(s.userGuardians.requestedAt))
    .all();
}

/** The user's accepted guardian, if any (most recently requested wins). */
export function getAcceptedGuardian(st: Store, userId: string): Guardian | null {
  const link = st.db
    .select()
    .from(s.userGuardians)
    .where(and(eq(s.userGuardians.userId, userId), eq(s.userGuardians.status, "accepted")))
    .orderBy(desc(s.userGuardians.requestedAt))
    .get();
  return link ? getGuardian(st, link.guardianId) : null;
}

// ---------- plans ----------

type PlanRow = typeof s.plans.$inferSelect;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

interface EngineStateJson {
  flags?: Partial<PlanFlags>;
  pendingSpot?: PendingSpot | null;
}

function toPlan(r: PlanRow): EnginePlan {
  const engine = parseJson<EngineStateJson>(r.engineStateJson, {});
  return {
    id: r.id,
    userId: r.userId,
    guardianId: r.guardianId,
    state: r.state as PlanState,
    type: r.type as PlanType | null,
    startAt: r.startAt,
    endAt: r.endAt,
    graceMin: r.graceMin,
    venueText: r.venueText,
    venueLat: r.venueLat,
    venueLng: r.venueLng,
    venuePlaceType: r.venuePlaceType,
    counterpartName: r.counterpartName,
    counterpartSource: r.counterpartSource,
    transport: r.transport as Transport | null,
    firstTimeInPerson: r.firstTimeInPerson,
    buyOrSell: r.buyOrSell as "buy" | "sell" | null,
    privateAddress: r.privateAddress,
    userNervous: r.userNervous,
    highVigilance: r.highVigilance,
    notifyGuardianStartEnd: r.notifyGuardianStartEnd,
    locationMode: r.locationMode as LocationMode,
    ladderStep: r.ladderStep as LadderStep | null,
    ladderClass: r.ladderClass as LadderClass | null,
    ladderTrigger: r.ladderTrigger as TriggerId | null,
    ladderStartedAt: r.ladderStartedAt,
    escalatedAt: r.escalatedAt,
    escalationReason: parseJson<EscalationReason | null>(r.escalationReasonJson, null),
    guardianAckAt: r.guardianAckAt,
    arrivedAt: r.arrivedAt,
    arrivalLineSent: r.arrivalLineSent,
    totalExtensionMin: r.totalExtensionMin,
    suppressedUntil: parseJson<Partial<Record<TriggerId, string>>>(r.suppressedUntilJson, {}),
    exitWordAt: r.exitWordAt,
    closedAt: r.closedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastCheckinMessageId: r.lastCheckinMessageId,
    lastCheckinAt: r.lastCheckinAt,
    guardianRepeatCount: r.guardianRepeatCount,
    lastGuardianUpdateAt: r.lastGuardianUpdateAt,
    lastGuardianUpdateLat: r.lastGuardianUpdateLat,
    lastGuardianUpdateLng: r.lastGuardianUpdateLng,
    ladderStepAt: r.ladderStepAt,
    locRequestedAt: r.locRequestedAt,
    shareConfirmedAt: r.shareConfirmedAt,
    shareExpiresAt: r.shareExpiresAt,
    lastResolvedAt: r.lastResolvedAt,
    pendingSpot: engine.pendingSpot ?? null,
    flags: { ...DEFAULT_FLAGS, ...(engine.flags ?? {}) },
  };
}

function toRow(p: EnginePlan): typeof s.plans.$inferInsert {
  const engine: EngineStateJson = { flags: p.flags, pendingSpot: p.pendingSpot };
  return {
    id: p.id,
    userId: p.userId,
    guardianId: p.guardianId,
    state: p.state,
    type: p.type,
    startAt: p.startAt,
    endAt: p.endAt,
    graceMin: p.graceMin,
    venueText: p.venueText,
    venueLat: p.venueLat,
    venueLng: p.venueLng,
    venuePlaceType: p.venuePlaceType,
    counterpartName: p.counterpartName,
    counterpartSource: p.counterpartSource,
    transport: p.transport,
    firstTimeInPerson: p.firstTimeInPerson,
    buyOrSell: p.buyOrSell,
    privateAddress: p.privateAddress,
    userNervous: p.userNervous,
    highVigilance: p.highVigilance,
    notifyGuardianStartEnd: p.notifyGuardianStartEnd,
    locationMode: p.locationMode,
    ladderStep: p.ladderStep,
    ladderClass: p.ladderClass,
    ladderTrigger: p.ladderTrigger,
    ladderStartedAt: p.ladderStartedAt,
    ladderStepAt: p.ladderStepAt,
    escalatedAt: p.escalatedAt,
    escalationReasonJson: p.escalationReason ? JSON.stringify(p.escalationReason) : null,
    guardianAckAt: p.guardianAckAt,
    arrivedAt: p.arrivedAt,
    arrivalLineSent: p.arrivalLineSent,
    totalExtensionMin: p.totalExtensionMin,
    suppressedUntilJson: JSON.stringify(p.suppressedUntil ?? {}),
    exitWordAt: p.exitWordAt,
    lastCheckinMessageId: p.lastCheckinMessageId,
    lastCheckinAt: p.lastCheckinAt,
    guardianRepeatCount: p.guardianRepeatCount,
    lastGuardianUpdateAt: p.lastGuardianUpdateAt,
    lastGuardianUpdateLat: p.lastGuardianUpdateLat,
    lastGuardianUpdateLng: p.lastGuardianUpdateLng,
    locRequestedAt: p.locRequestedAt,
    shareConfirmedAt: p.shareConfirmedAt,
    shareExpiresAt: p.shareExpiresAt,
    lastResolvedAt: p.lastResolvedAt,
    engineStateJson: JSON.stringify(engine),
    closedAt: p.closedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function insertPlan(st: Store, plan: EnginePlan): EnginePlan {
  st.db.insert(s.plans).values(toRow(plan)).run();
  return getPlan(st, plan.id)!;
}

export function getPlan(st: Store, id: string): EnginePlan | null {
  const r = st.db.select().from(s.plans).where(eq(s.plans.id, id)).get();
  return r ? toPlan(r) : null;
}

/** Persist the whole plan record (engine output). */
export function savePlan(st: Store, plan: EnginePlan): void {
  const { id, ...rest } = toRow(plan);
  st.db.update(s.plans).set(rest).where(eq(s.plans.id, id)).run();
}

/** The user's newest plan that is not CLOSED, CANCELLED, or EXPIRED (one per user, spec 4.4.6). */
export function getOpenPlanForUser(st: Store, userId: string): EnginePlan | null {
  const r = st.db
    .select()
    .from(s.plans)
    .where(and(eq(s.plans.userId, userId), notInArray(s.plans.state, [...TERMINAL_STATES])))
    .orderBy(desc(s.plans.createdAt))
    .get();
  return r ? toPlan(r) : null;
}

export function listPlansInStates(st: Store, states: readonly PlanState[]): EnginePlan[] {
  return st.db.select().from(s.plans).where(inArray(s.plans.state, [...states])).orderBy(asc(s.plans.createdAt)).all().map(toPlan);
}

/** Plans in an escalation that involves this guardian (spec 8.4 step 5 routing). */
export function listEscalatedPlansForGuardian(st: Store, guardianId: string): EnginePlan[] {
  return st.db
    .select()
    .from(s.plans)
    .where(and(eq(s.plans.guardianId, guardianId), eq(s.plans.state, "ESCALATED")))
    .all()
    .map(toPlan);
}

// ---------- plan_events (audit) ----------

export interface PlanEvent {
  id: number;
  planId: string;
  at: Date;
  kind: string;
  data: Record<string, unknown> | null;
}

export function addPlanEvent(st: Store, planId: string, kind: string, data: Record<string, unknown> | undefined, at: Date): void {
  st.db
    .insert(s.planEvents)
    .values({ planId, at, kind, dataJson: data ? JSON.stringify(data) : null })
    .run();
}

export function listPlanEvents(st: Store, planId: string): PlanEvent[] {
  return st.db
    .select()
    .from(s.planEvents)
    .where(eq(s.planEvents.planId, planId))
    .orderBy(asc(s.planEvents.id))
    .all()
    .map((r) => ({ id: r.id, planId: r.planId, at: r.at, kind: r.kind, data: parseJson<Record<string, unknown> | null>(r.dataJson, null) }));
}

// ---------- location_fixes ----------

export function insertFix(st: Store, planId: string, fix: Fix, receivedAt: Date): void {
  st.db
    .insert(s.locationFixes)
    .values({
      planId,
      at: fix.at,
      lat: fix.lat,
      lng: fix.lng,
      accuracyM: fix.accuracyM,
      locationType: fix.locationType,
      source: fix.source,
      expiresAt: fix.expiresAt,
      receivedAt,
    })
    .run();
}

/** Fixes for a plan, ascending by time. `since` bounds the window (inclusive). */
export function listFixes(st: Store, planId: string, opts: { since?: Date; limit?: number } = {}): Fix[] {
  const where = opts.since ? and(eq(s.locationFixes.planId, planId), gte(s.locationFixes.at, opts.since)) : eq(s.locationFixes.planId, planId);
  let rows = st.db.select().from(s.locationFixes).where(where).orderBy(asc(s.locationFixes.at), asc(s.locationFixes.id)).all();
  if (opts.limit !== undefined && rows.length > opts.limit) rows = rows.slice(rows.length - opts.limit);
  return rows.map((r) => ({
    lat: r.lat,
    lng: r.lng,
    accuracyM: r.accuracyM,
    at: r.at,
    locationType: r.locationType as Fix["locationType"],
    expiresAt: r.expiresAt,
    source: r.source as Fix["source"],
  }));
}

const COORD_KEY = /^(lat|lng|lon|latitude|longitude|ll|coords?|coordinates)$|(Lat|Lng|Lon|Latitude|Longitude)$|_(lat|lng|lon)$/;

/** Remove coordinates from an audit payload (I12): coordinate keys dropped, map links masked. */
export function stripCoordinates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCoordinates);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (COORD_KEY.test(k)) continue;
      out[k] = stripCoordinates(v);
    }
    return out;
  }
  if (typeof value === "string" && /maps\.(apple|google)\.com|[-+]?\d{1,3}\.\d{3,}\s*,\s*[-+]?\d{1,3}\.\d{3,}/.test(value)) {
    return "[location removed]";
  }
  return value;
}

/** I12: delete raw fixes and strip coordinates from the plan's audit events. */
export function purgePlanLocation(st: Store, planId: string): { fixesDeleted: number; eventsStripped: number } {
  return st.sqlite.transaction(() => {
    const del = st.db.delete(s.locationFixes).where(eq(s.locationFixes.planId, planId)).run();
    let stripped = 0;
    const events = st.db.select().from(s.planEvents).where(eq(s.planEvents.planId, planId)).all();
    for (const e of events) {
      if (!e.dataJson) continue;
      const clean = JSON.stringify(stripCoordinates(parseJson<unknown>(e.dataJson, null)));
      if (clean !== e.dataJson) {
        st.db.update(s.planEvents).set({ dataJson: clean }).where(eq(s.planEvents.id, e.id)).run();
        stripped++;
      }
    }
    st.db
      .update(s.plans)
      .set({ lastGuardianUpdateLat: null, lastGuardianUpdateLng: null })
      .where(eq(s.plans.id, planId))
      .run();
    return { fixesDeleted: del.changes, eventsStripped: stripped };
  })();
}

/** Plans closed more than 24 h ago that still hold fixes (safety net for a missed purge job). */
export function listPlansNeedingPurge(st: Store, now: Date): string[] {
  const cutoff = new Date(now.getTime() - 24 * 3600_000);
  const rows = st.sqlite
    .prepare(
      `SELECT DISTINCT p.id AS id FROM plans p JOIN location_fixes f ON f.plan_id = p.id
       WHERE p.state IN ('CLOSED','CANCELLED','EXPIRED') AND p.closed_at IS NOT NULL AND p.closed_at <= ?`,
    )
    .all(cutoff.getTime()) as { id: string }[];
  return rows.map((r) => r.id);
}

// ---------- messages ----------

export function recordMessage(
  st: Store,
  input: {
    platformMessageId: string | null;
    direction: "inbound" | "outbound";
    addressE164: E164;
    planId?: string | null;
    kind: string;
    bodyRedacted: string | null;
    sentAt: Date;
  },
): void {
  st.db
    .insert(s.messages)
    .values({
      platformMessageId: input.platformMessageId,
      direction: input.direction,
      addressE164: input.addressE164,
      planId: input.planId ?? null,
      kind: input.kind,
      bodyRedacted: input.bodyRedacted,
      sentAt: input.sentAt,
    })
    .onConflictDoNothing()
    .run();
}

// ---------- processed_inbound (dedupe, spec 8.4 step 4) ----------

/** Returns true the first time a message id is seen, false for duplicates. */
export function markInboundProcessed(st: Store, messageId: string, at: Date): boolean {
  const r = st.db.insert(s.processedInbound).values({ messageId, at }).onConflictDoNothing().run();
  return r.changes === 1;
}

/** Drop dedupe rows older than 7 days. */
export function pruneProcessedInbound(st: Store, now: Date): number {
  return st.db.delete(s.processedInbound).where(lt(s.processedInbound.at, new Date(now.getTime() - 7 * 86400_000))).run().changes;
}

// ---------- counters (quotas, spec 8.5) ----------

export function incrementCounter(st: Store, day: string, key: string, by = 1): number {
  st.sqlite
    .prepare("INSERT INTO counters (day, key, value) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET value = value + excluded.value")
    .run(day, key, by);
  return getCounter(st, day, key);
}

export function getCounter(st: Store, day: string, key: string): number {
  const r = st.db.select().from(s.counters).where(and(eq(s.counters.day, day), eq(s.counters.key, key))).get();
  return r?.value ?? 0;
}
