// In-memory DialogueRepo for tests, simulations, and the terminal chat without a database.
// The production implementation lives in store/ (core-engineer) and must keep the same semantics.
import type { E164, Guardian, Plan, User } from "../contracts.js";
import { TERMINAL_STATES } from "../contracts.js";
import type { CodeWords } from "../pipeline/codewords.js";
import type { DialogueRepo, DialogueState, GuardianLink, PlanFieldPatch } from "./ports.js";

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

export function blankPlan(userId: string, now: Date, init: PlanFieldPatch = {}): Plan {
  return {
    id: id("plan"),
    userId,
    guardianId: null,
    state: "DRAFT",
    type: null,
    startAt: null,
    endAt: null,
    graceMin: 15,
    venueText: null,
    venueLat: null,
    venueLng: null,
    venuePlaceType: null,
    counterpartName: null,
    counterpartSource: null,
    transport: null,
    firstTimeInPerson: null,
    buyOrSell: null,
    privateAddress: null,
    userNervous: false,
    highVigilance: false,
    notifyGuardianStartEnd: false,
    locationMode: "none",
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
    createdAt: now,
    updatedAt: now,
    ...init,
  };
}

export class MemoryDialogueRepo implements DialogueRepo {
  readonly users = new Map<string, User>();
  readonly guardians = new Map<string, Guardian>();
  readonly links: GuardianLink[] = [];
  readonly plans = new Map<string, Plan>();
  readonly codeWords = new Map<string, CodeWords>();
  readonly stopped = new Map<string, Date>();
  readonly dialogue = new Map<string, DialogueState>();

  async getUserByAddress(address: E164) {
    for (const u of this.users.values()) if (u.addressE164 === address && !u.deletedAt) return { ...u };
    return null;
  }
  async getUser(id: string) {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }
  async createUser(address: E164, now: Date) {
    const u: User = {
      id: id("user"),
      addressE164: address,
      displayName: null,
      tz: null,
      onboardingStep: "ask_name",
      decoyCaller: "roommate",
      homeLat: null,
      homeLng: null,
      createdAt: now,
      deletedAt: null,
    };
    this.users.set(u.id, u);
    return { ...u };
  }
  async updateUser(id: string, patch: Partial<User>) {
    const u = this.users.get(id);
    if (u) this.users.set(id, { ...u, ...patch });
  }
  async setCodeWords(userId: string, cw: CodeWords) {
    this.codeWords.set(userId, { ...cw });
  }
  async getCodeWords(userId: string) {
    return this.codeWords.get(userId) ?? null;
  }
  async deleteUserData(userId: string) {
    this.users.delete(userId);
    this.codeWords.delete(userId);
    this.dialogue.delete(userId);
    for (const [pid, p] of this.plans) if (p.userId === userId) this.plans.delete(pid);
    for (let i = this.links.length - 1; i >= 0; i--) if (this.links[i]!.userId === userId) this.links.splice(i, 1);
  }
  async setStopped(address: E164, at: Date | null) {
    if (at) this.stopped.set(address, at);
    else this.stopped.delete(address);
  }
  async isStopped(address: E164) {
    return this.stopped.has(address);
  }
  async getGuardianByAddress(address: E164) {
    for (const g of this.guardians.values()) if (g.addressE164 === address) return { ...g };
    return null;
  }
  async getGuardian(id: string) {
    const g = this.guardians.get(id);
    return g ? { ...g } : null;
  }
  async createGuardian(address: E164, displayName: string | null, now: Date) {
    const g: Guardian = { id: id("gdn"), addressE164: address, displayName, createdAt: now, stoppedAt: null };
    this.guardians.set(g.id, g);
    return { ...g };
  }
  async updateGuardian(id: string, patch: Partial<Guardian>) {
    const g = this.guardians.get(id);
    if (g) this.guardians.set(id, { ...g, ...patch });
  }
  async getLink(userId: string, guardianId: string) {
    const l = this.links.find((x) => x.userId === userId && x.guardianId === guardianId);
    return l ? { ...l } : null;
  }
  async listLinksForUser(userId: string) {
    return this.links.filter((l) => l.userId === userId).map((l) => ({ ...l }));
  }
  async listLinksForGuardian(guardianId: string) {
    return this.links.filter((l) => l.guardianId === guardianId).map((l) => ({ ...l }));
  }
  async upsertLink(link: GuardianLink) {
    const i = this.links.findIndex((x) => x.userId === link.userId && x.guardianId === link.guardianId);
    if (i >= 0) this.links[i] = { ...link };
    else this.links.push({ ...link });
  }
  async getOpenPlanForUser(userId: string) {
    const open = [...this.plans.values()].filter((p) => p.userId === userId && !TERMINAL_STATES.includes(p.state));
    open.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return open[0] ? { ...open[0] } : null;
  }
  async getPlan(id: string) {
    const p = this.plans.get(id);
    return p ? { ...p } : null;
  }
  async listOpenPlansForGuardian(guardianId: string) {
    return [...this.plans.values()].filter((p) => p.guardianId === guardianId && !TERMINAL_STATES.includes(p.state)).map((p) => ({ ...p }));
  }
  async createDraftPlan(userId: string, init: PlanFieldPatch, now: Date) {
    const p = blankPlan(userId, now, init);
    this.plans.set(p.id, p);
    return { ...p };
  }
  async updatePlanFields(planId: string, patch: PlanFieldPatch) {
    const p = this.plans.get(planId);
    if (p) this.plans.set(planId, { ...p, ...patch });
  }
  async getDialogueState(userId: string) {
    const s = this.dialogue.get(userId);
    return s ? (JSON.parse(JSON.stringify(s)) as DialogueState) : null;
  }
  async setDialogueState(userId: string, state: DialogueState | null) {
    if (state) this.dialogue.set(userId, JSON.parse(JSON.stringify(state)) as DialogueState);
    else this.dialogue.delete(userId);
  }
  /** Test helper: force a plan state (the real engine owns transitions). */
  setPlanState(planId: string, state: Plan["state"]) {
    const p = this.plans.get(planId);
    if (p) this.plans.set(planId, { ...p, state });
  }
}
