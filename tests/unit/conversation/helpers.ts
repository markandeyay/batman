// Shared fakes for conversation unit and invariant tests.
import type { Clock, E164, JobSpec, Plan, PlanState, SentRef, TemplateId } from "../../../apps/server/src/contracts.js";
import { MemoryDialogueRepo } from "../../../apps/server/src/dialogue/memoryRepo.js";
import type { DialogueEvent, DialoguePorts, GuardianRegistration } from "../../../apps/server/src/dialogue/ports.js";
import { handleInbound } from "../../../apps/server/src/dialogue/manager.js";
import type { Geocoder, GeocodeResult } from "../../../apps/server/src/geo/geocode.js";
import type { LlmProvider } from "../../../apps/server/src/nlu/llm.js";
import { renderTemplate, type TemplateParams } from "../../../apps/server/src/notify/templates.js";

export const USER: E164 = "+13125550101";
export const GUARDIAN: E164 = "+19195550142";
export const GUARDIAN_POOL: E164 = "+16285550100";
export const TZ = "America/Chicago";
/** Saturday 2026-10-17 15:00 in Chicago (CDT, UTC-5). */
export const NOW = new Date("2026-10-17T20:00:00Z");

export class FakeClock implements Clock {
  constructor(public t: Date = NOW) {}
  now() {
    return new Date(this.t);
  }
  async sleep(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export interface Sent {
  to: E164;
  template: TemplateId | null;
  params: TemplateParams;
  text: string;
}

export class FixedGeocoder implements Geocoder {
  readonly name = "fixed";
  calls: string[] = [];
  constructor(private readonly results: Record<string, GeocodeResult> = {}) {}
  async geocode(q: string): Promise<GeocodeResult[]> {
    this.calls.push(q);
    const hit = Object.entries(this.results).find(([k]) => q.toLowerCase().includes(k.toLowerCase()));
    return hit ? [hit[1]] : [];
  }
  async reverse(): Promise<string | null> {
    return "1820 N Milwaukee Ave, Chicago";
  }
}

export interface Harness {
  ports: DialoguePorts;
  repo: MemoryDialogueRepo;
  clock: FakeClock;
  sent: Sent[];
  dispatched: Array<{ planId: string; event: DialogueEvent }>;
  reactions: string[];
  contactCards: E164[];
  registered: E164[];
  scheduled: JobSpec[];
  iMessageChecks: E164[];
  inbound(from: E164, content: import("../../../apps/server/src/contracts.js").InboundContent): Promise<string>;
  text(from: E164, text: string, opts?: { fromVoice?: boolean }): Promise<string>;
  sentTo(to: E164): Sent[];
  clear(): void;
}

let msgSeq = 0;

export function makeHarness(opts: { llm?: LlmProvider | null; geocoder?: Geocoder; registration?: GuardianRegistration | null } = {}): Harness {
  const repo = new MemoryDialogueRepo();
  const clock = new FakeClock();
  const sent: Sent[] = [];
  const dispatched: Harness["dispatched"] = [];
  const reactions: string[] = [];
  const contactCards: E164[] = [];
  const registered: E164[] = [];
  const scheduled: JobSpec[] = [];
  const iMessageChecks: E164[] = [];
  let sendSeq = 0;
  const ref = (): SentRef => ({ id: `out_${++sendSeq}`, at: clock.now() });

  const ports: DialoguePorts = {
    repo,
    clock,
    async dispatch(planId, event) {
      dispatched.push({ planId, event });
      // Minimal engine stand-in: only the transitions dialogue tests rely on.
      const plan = repo.plans.get(planId);
      if (!plan) return;
      let next: PlanState | null = null;
      if (event.type === "arm") next = event.guardianAccepted ? "ARMED" : "AWAITING_GUARDIAN";
      if (event.type === "guardian_accepted" && plan.state === "AWAITING_GUARDIAN") next = "ARMED";
      if (event.type === "user_command" && event.command === "cancel") next = "CANCELLED";
      if (event.type === "user_command" && event.command === "home") next = "CLOSED";
      if (next) repo.setPlanState(planId, next);
    },
    async sendTemplate(to, template, params = {}) {
      if (await repo.isStopped(to)) return null; // production executors must drop too (I14)
      sent.push({ to, template, params, text: renderTemplate(template, { tz: TZ, now: clock.now(), ...params }, { variant: 0 }) });
      return ref();
    },
    async sendText(to, text) {
      if (await repo.isStopped(to)) return null;
      sent.push({ to, template: null, params: {}, text });
      return ref();
    },
    async react(messageId) {
      reactions.push(messageId);
    },
    async typing(_to, fn) {
      return fn();
    },
    async shareContactCard(to) {
      contactCards.push(to);
    },
    async registerGuardianAddress(address) {
      registered.push(address);
      return opts.registration === undefined ? { assignedNumber: GUARDIAN_POOL, smsLink: `sms:${GUARDIAN_POOL}` } : opts.registration;
    },
    async isIMessageAvailable(address) {
      iMessageChecks.push(address);
      return true;
    },
    async schedule(job) {
      scheduled.push(job);
    },
    geocoder: opts.geocoder ?? new FixedGeocoder({ "lula cafe": { lat: 41.9172, lng: -87.7067, displayName: "Lula Cafe", placeType: "cafe", residential: false } }),
    llm: opts.llm ?? null,
    config: { defaultTz: TZ },
    rng: () => 0,
  };

  const h: Harness = {
    ports,
    repo,
    clock,
    sent,
    dispatched,
    reactions,
    contactCards,
    registered,
    scheduled,
    iMessageChecks,
    async inbound(from, content) {
      const r = await handleInbound(ports, { id: `in_${++msgSeq}`, from, at: clock.now(), content });
      return r.route;
    },
    text(from, text, o = {}) {
      return h.inbound(from, { kind: "text", text, ...(o.fromVoice ? { fromVoice: true } : {}) });
    },
    sentTo(to) {
      return sent.filter((s) => s.to === to);
    },
    clear() {
      sent.length = 0;
      dispatched.length = 0;
      reactions.length = 0;
    },
  };
  return h;
}

/** Create an onboarded user with code words and (optionally) an accepted guardian. */
export async function seedUser(
  h: Harness,
  opts: { address?: E164; name?: string; guardian?: "accepted" | "pending" | "none"; guardianAddress?: E164; tz?: string } = {},
) {
  const address = opts.address ?? USER;
  const user = await h.repo.createUser(address, h.clock.now());
  await h.repo.updateUser(user.id, { displayName: opts.name ?? "Alex", onboardingStep: "done", tz: opts.tz ?? TZ });
  await h.repo.setCodeWords(user.id, { exit: "pineapple", alert: "blue moon" });
  let guardianId: string | null = null;
  if ((opts.guardian ?? "accepted") !== "none") {
    const g =
      (await h.repo.getGuardianByAddress(opts.guardianAddress ?? GUARDIAN)) ??
      (await h.repo.createGuardian(opts.guardianAddress ?? GUARDIAN, "Priya", h.clock.now()));
    guardianId = g.id;
    const accepted = (opts.guardian ?? "accepted") === "accepted";
    await h.repo.upsertLink({
      userId: user.id,
      guardianId: g.id,
      status: accepted ? "accepted" : "pending",
      requestedAt: h.clock.now(),
      respondedAt: accepted ? h.clock.now() : null,
      optinSentAt: h.clock.now(),
    });
  }
  return { user: (await h.repo.getUser(user.id))!, guardianId };
}

/** Put a complete plan for the user in the given state. */
export async function seedPlan(h: Harness, userId: string, guardianId: string | null, state: PlanState, extra: Partial<Plan> = {}) {
  const p = await h.repo.createDraftPlan(
    userId,
    {
      guardianId,
      type: "date",
      startAt: new Date("2026-10-18T00:00:00Z"),
      endAt: new Date("2026-10-18T02:00:00Z"),
      venueText: "Lula Cafe, 2537 N Kedzie",
      venueLat: 41.9172,
      venueLng: -87.7067,
      counterpartName: "Jordan",
      counterpartSource: "Hinge",
      transport: "self_drive",
    },
    h.clock.now(),
  );
  h.repo.setPlanState(p.id, state);
  if (Object.keys(extra).length > 0) h.repo.plans.set(p.id, { ...h.repo.plans.get(p.id)!, ...extra });
  return (await h.repo.getPlan(p.id))!;
}
