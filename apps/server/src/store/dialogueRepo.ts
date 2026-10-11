// DialogueRepo (dialogue/ports.ts) backed by the SQLite store (M4, spec 12). The dialogue manager
// runs against this in production; dialogue/memoryRepo.ts keeps the same semantics for unit tests.
// Plan creation and field edits go through PlanRuntime (hooks), so drafts get their 12 h
// draft_expire job and edits never interleave with a running dispatch on the same plan.
import { PLAN_STATES, TERMINAL_STATES, type E164, type Guardian, type Plan, type User } from "../contracts.js";
import type { DialogueRepo, DialogueState, GuardianLink, PlanFieldPatch } from "../dialogue/ports.js";
import type { CodeWords } from "../pipeline/codewords.js";
import type { DraftInput } from "../plan/factory.js";
import type { EnginePlan } from "../plan/types.js";
import type { Store } from "./db.js";
import * as repo from "./repo.js";

export interface StoreDialogueHooks {
  /** PlanRuntime.createDraft: inserts the DRAFT and schedules draft_expire. */
  createDraft(input: Omit<DraftInput, "now">): EnginePlan;
  /** PlanRuntime.updatePlanFields: serialized with the plan's engine events. */
  updatePlanFields(planId: string, patch: PlanFieldPatch): Promise<void>;
  /** Clock for dialogue_state timestamps. Default wall time. */
  now?: () => Date;
}

const OPEN_STATES = PLAN_STATES.filter((s) => !TERMINAL_STATES.includes(s));

export class StoreDialogueRepo implements DialogueRepo {
  constructor(
    private readonly store: Store,
    private readonly hooks: StoreDialogueHooks,
  ) {}

  private now(): Date {
    return this.hooks.now ? this.hooks.now() : new Date();
  }

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
  /** Deletes the user, plans (cascading to fixes, events, outbox), consent records, and dialogue state. */
  async deleteUserData(userId: string): Promise<void> {
    repo.deleteUserData(this.store, userId);
  }

  // ---------- I14 ----------
  async setStopped(address: E164, at: Date | null): Promise<void> {
    repo.setStopped(this.store, address, at);
  }
  async isStopped(address: E164): Promise<boolean> {
    return repo.isStopped(this.store, address);
  }
  /** Synchronous check for senders that cannot await (executor, harness). */
  isStoppedSync(address: E164): boolean {
    return repo.isStopped(this.store, address);
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
    repo.updateGuardian(this.store, id, patch);
  }

  // ---------- consent links ----------
  async getLink(userId: string, guardianId: string): Promise<GuardianLink | null> {
    return repo.getGuardianLink(this.store, userId, guardianId);
  }
  async listLinksForUser(userId: string): Promise<GuardianLink[]> {
    return repo.listGuardianLinksForUser(this.store, userId);
  }
  async listLinksForGuardian(guardianId: string): Promise<GuardianLink[]> {
    return repo.listGuardianLinksForGuardian(this.store, guardianId);
  }
  async upsertLink(link: GuardianLink): Promise<void> {
    repo.upsertGuardianLink(this.store, link);
  }

  // ---------- plans ----------
  async getOpenPlanForUser(userId: string): Promise<Plan | null> {
    return repo.getOpenPlanForUser(this.store, userId);
  }
  async getPlan(id: string): Promise<Plan | null> {
    return repo.getPlan(this.store, id);
  }
  async listOpenPlansForGuardian(guardianId: string): Promise<Plan[]> {
    return repo.listPlansInStates(this.store, OPEN_STATES).filter((p) => p.guardianId === guardianId);
  }
  async createDraftPlan(userId: string, init: PlanFieldPatch, _now: Date): Promise<Plan> {
    return this.hooks.createDraft({ id: repo.newId(), userId, guardianId: init.guardianId ?? null, ...init });
  }
  async updatePlanFields(planId: string, patch: PlanFieldPatch): Promise<void> {
    await this.hooks.updatePlanFields(planId, patch);
  }

  // ---------- dialogue context ----------
  async getDialogueState(userId: string): Promise<DialogueState | null> {
    return (repo.getDialogueStateJson(this.store, userId) as DialogueState | null) ?? null;
  }
  async setDialogueState(userId: string, state: DialogueState | null): Promise<void> {
    repo.setDialogueStateJson(this.store, userId, state, this.now());
  }
}
