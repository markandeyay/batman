// DialogueRepo (dialogue/ports.ts) backed by the real SQLite store (store/repo.ts), for the
// full-stack simulation. This is harness glue and the blueprint for the production adapter in
// index.ts. Contract gaps it bridges (each listed in the test-engineer report):
//   1. user_guardians has no opt-in-sent column: GuardianLink.optinSentAt lives in a side map.
//   2. No address-level STOP table (I14): setStopped/isStopped live in a side map.
//   3. No dialogue_state table (resumable intake, 4.2): DialogueState lives in a side map.
//   4. No "update guardian" or "open plans for guardian" functions in store/repo.ts: written here.
//   5. createDraftPlan goes through PlanRuntime.createDraft so the 12 h draft_expire job exists.
//   6. updatePlanFields writes the plan row directly, outside PlanRuntime's per-plan queue.
import { TERMINAL_STATES, type E164, type Guardian, type Plan, type User } from "../../apps/server/src/contracts.js";
import type { DialogueRepo, DialogueState, GuardianLink, PlanFieldPatch } from "../../apps/server/src/dialogue/ports.js";
import type { CodeWords } from "../../apps/server/src/pipeline/codewords.js";
import type { PlanRuntime } from "../../apps/server/src/plan/runtime.js";
import { PLAN_STATES } from "../../apps/server/src/contracts.js";
import type { Store } from "../../apps/server/src/store/db.js";
import * as repo from "../../apps/server/src/store/repo.js";
import type { Clock } from "../../apps/server/src/contracts.js";

const linkKey = (userId: string, guardianId: string) => `${userId}|${guardianId}`;
const clone = <T>(x: T): T => (x === null || x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

export class StoreDialogueRepo implements DialogueRepo {
  /** Gap 1: when gdn_optin_request was sent, per link. */
  readonly optinSentAt = new Map<string, Date | null>();
  /** Gap 2: address-level STOP flags (I14). */
  readonly stopped = new Map<string, Date>();
  /** Gap 3: per-user dialogue context. */
  readonly dialogue = new Map<string, DialogueState>();

  constructor(
    private readonly store: Store,
    private readonly runtime: () => PlanRuntime,
    private readonly clock: Clock,
  ) {}

  // ---------- users ----------
  async getUserByAddress(address: E164): Promise<User | null> {
    const u = repo.getUserByAddress(this.store, address);
    return u && !u.deletedAt ? u : null;
  }
  async getUser(id: string): Promise<User | null> {
    return repo.getUser(this.store, id);
  }
  async createUser(address: E164, now: Date): Promise<User> {
    return repo.createUser(this.store, { addressE164: address, onboardingStep: "ask_name", now });
  }
  async updateUser(id: string, patch: Partial<Pick<User, "displayName" | "tz" | "onboardingStep" | "decoyCaller" | "homeLat" | "homeLng">>): Promise<void> {
    repo.updateUser(this.store, id, patch);
  }
  async setCodeWords(userId: string, cw: CodeWords): Promise<void> {
    repo.setCodeWords(this.store, userId, cw.exit, cw.alert);
  }
  async getCodeWords(userId: string): Promise<CodeWords | null> {
    return repo.getCodeWords(this.store, userId);
  }
  async deleteUserData(userId: string): Promise<void> {
    repo.deleteUserData(this.store, userId);
    this.dialogue.delete(userId);
    for (const k of [...this.optinSentAt.keys()]) if (k.startsWith(`${userId}|`)) this.optinSentAt.delete(k);
  }

  // ---------- I14 ----------
  async setStopped(address: E164, at: Date | null): Promise<void> {
    if (at) this.stopped.set(address, at);
    else this.stopped.delete(address);
  }
  async isStopped(address: E164): Promise<boolean> {
    return this.stopped.has(address);
  }
  isStoppedSync(address: E164): boolean {
    return this.stopped.has(address);
  }

  // ---------- guardians ----------
  async getGuardianByAddress(address: E164): Promise<Guardian | null> {
    return repo.getGuardianByAddress(this.store, address);
  }
  async getGuardian(id: string): Promise<Guardian | null> {
    return repo.getGuardian(this.store, id);
  }
  async createGuardian(address: E164, displayName: string | null, now: Date): Promise<Guardian> {
    return repo.upsertGuardian(this.store, { addressE164: address, displayName, now });
  }
  async updateGuardian(id: string, patch: Partial<Pick<Guardian, "displayName" | "stoppedAt">>): Promise<void> {
    // Raw SQL: drizzle-orm is a dependency of apps/server only.
    if (patch.displayName !== undefined) this.store.sqlite.prepare("UPDATE guardians SET display_name = ? WHERE id = ?").run(patch.displayName, id);
    if (patch.stoppedAt !== undefined) this.store.sqlite.prepare("UPDATE guardians SET stopped_at = ? WHERE id = ?").run(patch.stoppedAt?.getTime() ?? null, id);
  }

  // ---------- consent links ----------
  private withSent(l: repo.GuardianLink): GuardianLink {
    return { ...l, optinSentAt: this.optinSentAt.get(linkKey(l.userId, l.guardianId)) ?? null };
  }
  async getLink(userId: string, guardianId: string): Promise<GuardianLink | null> {
    const l = repo.getGuardianLink(this.store, userId, guardianId);
    return l ? this.withSent(l) : null;
  }
  async listLinksForUser(userId: string): Promise<GuardianLink[]> {
    return repo.listGuardianLinksForUser(this.store, userId).map((l) => this.withSent(l));
  }
  async listLinksForGuardian(guardianId: string): Promise<GuardianLink[]> {
    return repo.listGuardianLinksForGuardian(this.store, guardianId).map((l) => this.withSent(l));
  }
  async upsertLink(link: GuardianLink): Promise<void> {
    this.store.sqlite
      .prepare(
        `INSERT INTO user_guardians (user_id, guardian_id, status, requested_at, responded_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, guardian_id) DO UPDATE SET status = excluded.status, requested_at = excluded.requested_at, responded_at = excluded.responded_at`,
      )
      .run(link.userId, link.guardianId, link.status, link.requestedAt.getTime(), link.respondedAt?.getTime() ?? null);
    this.optinSentAt.set(linkKey(link.userId, link.guardianId), link.optinSentAt);
  }

  // ---------- plans ----------
  async getOpenPlanForUser(userId: string): Promise<Plan | null> {
    return repo.getOpenPlanForUser(this.store, userId);
  }
  async getPlan(id: string): Promise<Plan | null> {
    return repo.getPlan(this.store, id);
  }
  async listOpenPlansForGuardian(guardianId: string): Promise<Plan[]> {
    const open = PLAN_STATES.filter((s) => !TERMINAL_STATES.includes(s));
    return repo.listPlansInStates(this.store, open).filter((p) => p.guardianId === guardianId);
  }
  async createDraftPlan(userId: string, init: PlanFieldPatch, _now: Date): Promise<Plan> {
    return this.runtime().createDraft({ id: repo.newId(), userId, guardianId: init.guardianId ?? null, ...init });
  }
  async updatePlanFields(planId: string, patch: PlanFieldPatch): Promise<void> {
    const p = repo.getPlan(this.store, planId);
    if (!p) return;
    repo.savePlan(this.store, { ...p, ...patch, updatedAt: this.clock.now() });
  }

  // ---------- dialogue context ----------
  async getDialogueState(userId: string): Promise<DialogueState | null> {
    return clone(this.dialogue.get(userId) ?? null);
  }
  async setDialogueState(userId: string, state: DialogueState | null): Promise<void> {
    if (state) this.dialogue.set(userId, clone(state));
    else this.dialogue.delete(userId);
  }
}
