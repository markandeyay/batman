// Engine-level simulation harness (spec 15.1 layer 4): real store, scheduler, and PlanRuntime
// on a FakeClock; a recording OutboundPort; replay tracks for fixes; scripted user events.
// No NLU: scripted texts map to engine events with fixed rules or an explicit label.
import { join } from "node:path";
import type { E164, EngineEvent, Fix, GuardianLinkStatus, SentRef } from "../../apps/server/src/contracts.js";
import { loadTrack, materializeTrack, type MaterializedTrack } from "../../apps/server/src/location/replay.js";
import type { DraftInput } from "../../apps/server/src/plan/factory.js";
import { PlanRuntime, type OutboundPort } from "../../apps/server/src/plan/runtime.js";
import type { EnginePlan } from "../../apps/server/src/plan/types.js";
import { JobScheduler } from "../../apps/server/src/scheduler/jobs.js";
import { openStore, type Store } from "../../apps/server/src/store/db.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { FakeClock } from "../../apps/server/src/util/clock.js";

export const START = new Date("2026-10-10T23:00:00Z"); // Sat 19:00 in New York
export const USER: E164 = "+13125550100";
export const GUARDIAN: E164 = "+19195550142";
export const STRANGER: E164 = "+13125550199";
const TRACKS = join(import.meta.dirname, "../fixtures/tracks");
const MIN = 60_000;

export interface OutRecord {
  /** Minutes relative to plan start, rounded to 0.01. */
  t: number;
  kind: "send" | "react" | "call" | "request_location" | "start_watch" | "stop_watch";
  to?: "user" | "guardian";
  template?: string;
  script?: string;
  critical?: boolean;
  notifyAnyway?: boolean;
  params?: Record<string, unknown>;
}

export type ScriptItem = { t: number; event: EngineEvent } | { t: number; text: string; label?: "OK" | "NOT_OK" | "AMBIGUOUS" };

export interface SimOptions {
  track?: string;
  plan?: Partial<Omit<DraftInput, "id" | "userId" | "guardianId" | "now">>;
  /** Minutes relative to start when the user says go (default -120). */
  armAt?: number;
  userHome?: { lat: number; lng: number } | null;
  guardianStatus?: GuardianLinkStatus;
  /** Calls succeed (default true). */
  callsWork?: boolean;
  /** Replaces the track's userMessages. */
  script?: ScriptItem[];
  dbPath?: string;
  /** Minutes the user takes to accept the Find My card after it is sent (default 1). */
  acceptDelayMin?: number;
}

const rel = (d: Date) => Math.round(((d.getTime() - START.getTime()) / MIN) * 100) / 100;

/** Deterministic mapping of scripted texts to engine events (stands in for NLU). */
export function textToEvent(text: string, label: "OK" | "NOT_OK" | "AMBIGUOUS" | undefined, messageId: string): EngineEvent {
  const t = text.trim().toLowerCase();
  if (t === "home" || t === "im home" || t === "made it home") return { type: "user_command", command: "home" };
  if (t === "done" || t === "leaving") return { type: "user_command", command: "done" };
  if (t === "cancel") return { type: "user_command", command: "cancel" };
  const ext = /^\+(\d+)$/.exec(t);
  if (ext) return { type: "user_command", command: "extend", minutes: Number(ext[1]) };
  return { type: "user_reply", label: label ?? "OK", messageId };
}

export class Sim {
  readonly clock: FakeClock;
  store!: Store;
  scheduler!: JobScheduler;
  runtime!: PlanRuntime;
  readonly out: OutRecord[] = [];
  readonly track: MaterializedTrack | null;
  planId = "plan-sim";
  private watching = false;
  private fixPtr = 0;
  private script: { at: Date; item: ScriptItem }[] = [];
  private scriptPtr = 0;
  private sentCount = 0;
  private inCount = 0;
  private locRequestedAt: Date | null = null;
  readonly errors: unknown[] = [];

  private constructor(readonly opts: SimOptions) {
    this.clock = new FakeClock(new Date(START.getTime() + (opts.armAt ?? -120) * MIN));
    this.track = opts.track ? materializeTrack(loadTrack(join(TRACKS, `${opts.track}.json`)), START) : null;
  }

  static async create(opts: SimOptions = {}): Promise<Sim> {
    const sim = new Sim(opts);
    sim.boot();
    sim.seed();
    const items: ScriptItem[] =
      opts.script ?? (sim.track?.userMessages ?? []).map((m) => ({ t: (m.at.getTime() - START.getTime()) / MIN, text: m.text, ...(m.label ? { label: m.label } : {}) }));
    sim.script = items.map((item) => ({ at: new Date(START.getTime() + item.t * MIN), item })).sort((a, b) => a.at.getTime() - b.at.getTime());
    await sim.runtime.dispatch(sim.planId, { type: "arm", guardianAccepted: (opts.guardianStatus ?? "accepted") === "accepted" });
    return sim;
  }

  private boot(): void {
    this.store = openStore(this.opts.dbPath ?? ":memory:");
    this.scheduler = new JobScheduler(this.store, (job) => this.runtime.handleJob(job), {
      clock: this.clock,
      onError: (_j, e) => this.errors.push(e),
    });
    const port: OutboundPort = {
      send: async (e) => {
        const rec: OutRecord = { t: rel(this.clock.now()), kind: "send", to: e.to, template: e.template };
        if (e.critical) rec.critical = true;
        if (e.notifyAnyway) rec.notifyAnyway = true;
        if (e.params) rec.params = e.params;
        this.out.push(rec);
        const ref: SentRef = { id: `out-${++this.sentCount}`, at: this.clock.now() };
        return ref;
      },
      react: async () => void this.out.push({ t: rel(this.clock.now()), kind: "react" }),
      call: async (e) => {
        this.out.push({ t: rel(this.clock.now()), kind: "call", to: e.to, script: e.script });
        return this.opts.callsWork ?? true;
      },
      requestLocation: async () => {
        this.locRequestedAt = this.clock.now();
        this.out.push({ t: rel(this.clock.now()), kind: "request_location" });
      },
      startWatch: async () => {
        if (!this.watching) this.skipPastFixes();
        this.watching = true;
        this.out.push({ t: rel(this.clock.now()), kind: "start_watch" });
      },
      stopWatch: async () => {
        this.watching = false;
        this.out.push({ t: rel(this.clock.now()), kind: "stop_watch" });
      },
    };
    this.runtime = new PlanRuntime({
      store: this.store,
      clock: this.clock,
      jobs: this.scheduler,
      out: port,
      defaultTz: "America/New_York",
      shareProbe: async () => {
        const accepted = this.track ? this.track.share.accepted : false;
        const delay = (this.opts.acceptDelayMin ?? 1) * MIN;
        const visible = accepted && !!this.locRequestedAt && this.clock.now().getTime() >= this.locRequestedAt.getTime() + delay;
        return { visible, expiresAt: this.track?.share.expiresAt ?? null };
      },
      onError: (e) => this.errors.push(e),
    });
  }

  private seed(): void {
    const now = this.clock.now();
    const u = repo.createUser(this.store, { addressE164: USER, displayName: "Alex", tz: "America/New_York", onboardingStep: "done", now, id: "user-sim" });
    if (this.opts.userHome) repo.updateUser(this.store, u.id, { homeLat: this.opts.userHome.lat, homeLng: this.opts.userHome.lng });
    const g = repo.upsertGuardian(this.store, { addressE164: GUARDIAN, displayName: "Priya", now });
    repo.setGuardianLink(this.store, { userId: u.id, guardianId: g.id, status: this.opts.guardianStatus ?? "accepted", now });
    const venue = this.track?.venue ?? { lat: 41.9172, lng: -87.7067 };
    this.runtime.createDraft({
      id: this.planId,
      userId: u.id,
      guardianId: g.id,
      type: "date",
      startAt: START,
      durationMin: 120,
      venueText: "Lula Cafe",
      venueLat: venue.lat,
      venueLng: venue.lng,
      counterpartName: "Jordan",
      counterpartSource: "Hinge",
      transport: "self_drive",
      ...this.opts.plan,
    });
  }

  private skipPastFixes(): void {
    const fixes = this.track?.fixes ?? [];
    const now = this.clock.now().getTime();
    while (this.fixPtr < fixes.length && fixes[this.fixPtr]!.at.getTime() < now) this.fixPtr++;
  }

  private nextFixAt(): Date | null {
    if (!this.watching || !this.track) return null;
    return this.track.fixes[this.fixPtr]?.at ?? null;
  }

  /** Run every fix, scripted event, and due job up to `tMin` (minutes from start), in time order. */
  async runUntil(tMin: number): Promise<void> {
    const target = START.getTime() + tMin * MIN;
    for (let guard = 0; guard < 100_000; guard++) {
      const job = this.scheduler.nextRunAt();
      const fix = this.nextFixAt();
      const msg = this.script[this.scriptPtr]?.at ?? null;
      const candidates = [fix, msg, job].filter((d): d is Date => d !== null);
      if (candidates.length === 0) break;
      const next = Math.max(this.clock.now().getTime(), Math.min(...candidates.map((d) => d.getTime())));
      if (next > target) break;
      await this.clock.set(new Date(next));
      if (fix && fix.getTime() <= next) {
        const f = this.track!.fixes[this.fixPtr++]!;
        await this.runtime.ingestFix(this.planId, f);
        continue;
      }
      if (msg && msg.getTime() <= next) {
        const { item } = this.script[this.scriptPtr++]!;
        await this.deliver(item);
        continue;
      }
      await this.scheduler.runDue();
    }
    await this.clock.set(new Date(target));
  }

  private async deliver(item: ScriptItem): Promise<void> {
    if ("event" in item) {
      await this.runtime.dispatch(this.planId, item.event);
      return;
    }
    const id = `in-${++this.inCount}`;
    await this.runtime.dispatch(this.planId, textToEvent(item.text, item.label, id), { lastUserMessageId: id });
  }

  /** Inject an event now (outside the script). */
  async send(event: EngineEvent): Promise<void> {
    await this.runtime.dispatch(this.planId, event);
  }

  /** Host asleep: nothing runs and live fixes are missed until `toMin`. Then catch up (I16). */
  async sleepHost(fromMin: number, toMin: number): Promise<void> {
    await this.runUntil(fromMin);
    await this.clock.set(new Date(START.getTime() + toMin * MIN));
    this.skipPastFixes();
    await this.scheduler.start();
    await this.scheduler.stop();
  }

  /** Simulate a process restart on the same database file (S-06). */
  async restart(): Promise<void> {
    if (!this.opts.dbPath) throw new Error("restart needs dbPath");
    this.store.close();
    this.boot();
    this.scheduler.recoverInterrupted();
    await this.scheduler.runDue();
  }

  plan(): EnginePlan {
    return repo.getPlan(this.store, this.planId)!;
  }

  /** "to:template" for every send, optionally from minute `sinceMin`. */
  sends(sinceMin = -Infinity): string[] {
    return this.out.filter((o) => o.kind === "send" && o.t >= sinceMin).map((o) => `${o.to}:${o.template}`);
  }

  /** Timeline lines like "135 send user:ot_overtime" (calls, reacts, sends). */
  timeline(sinceMin = -Infinity): string[] {
    return this.out
      .filter((o) => o.t >= sinceMin && (o.kind === "send" || o.kind === "call" || o.kind === "react"))
      .map((o) => (o.kind === "send" ? `${o.t} send ${o.to}:${o.template}` : o.kind === "call" ? `${o.t} call ${o.to}:${o.script}` : `${o.t} react`));
  }

  guardianSends(): OutRecord[] {
    return this.out.filter((o) => o.kind === "send" && o.to === "guardian");
  }

  transitions(): string[] {
    return repo
      .listPlanEvents(this.store, this.planId)
      .filter((e) => e.kind === "state")
      .map((e) => `${String(e.data?.from)}->${String(e.data?.to)}`);
  }

  storedFixes(): Fix[] {
    return repo.listFixes(this.store, this.planId);
  }

  close(): void {
    this.store.close();
  }
}
