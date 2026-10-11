// Fakes for gateway tests: no network, no spectrum-ts runtime.
import type { E164, PlanState, TemplateId } from "../../../apps/server/src/contracts.js";
import { GatewayChannel, type FocusApi, type SpaceHandle, type SpaceResolver } from "../../../apps/server/src/gateway/channel.js";
import { GatewayExecutor, type ExecutorOptions } from "../../../apps/server/src/gateway/executor.js";
import { openStore, type Store } from "../../../apps/server/src/store/db.js";
import * as repo from "../../../apps/server/src/store/repo.js";
import { FakeClock } from "../../../apps/server/src/util/clock.js";
import { basePlan, T0 } from "../core/helpers.js";
import type { EnginePlan } from "../../../apps/server/src/plan/types.js";

export const USER = "+13125550100" as E164;
export const GUARDIAN = "+19195550142" as E164;

/** Error shaped like @photon-ai/advanced-imessage IMessageError. */
export function imErr(message: string, grpcCode: number, retryable: boolean, name = "IMessageError"): Error {
  const e = new Error(message) as Error & { grpcCode: number; retryable: boolean; code: string };
  e.name = name;
  e.grpcCode = grpcCode;
  e.retryable = retryable;
  e.code = "internalError";
  return e;
}

export const TARGET_NOT_ALLOWED = () => imErr("[spectrum-imessage] Target not allowed for this project", 7, false, "AuthenticationError");
export const POOL_NUMBER = () =>
  imErr("Target is a Photon-managed shared line, not a valid recipient. Send to the user's own number, not the assigned line.", 3, false, "ValidationError");
export const UNAVAILABLE = () => imErr("upstream unavailable", 14, true, "ConnectionError");

export class FakeSpace implements SpaceHandle {
  kind: "imessage" | "terminal" = "imessage";
  sent: string[] = [];
  failures: (() => Error)[] = [];
  responded = 0;
  shared = 0;
  private n = 0;
  constructor(public id: string) {}
  async send(text: string) {
    const f = this.failures.shift();
    if (f) throw f();
    this.sent.push(text);
    return { id: `spc-msg-${this.id.slice(-4)}-${++this.n}`, timestamp: new Date(T0.getTime() + this.n) };
  }
  async responding<T>(fn: () => Promise<T>) {
    this.responded++;
    return fn();
  }
  shareContactCard = async () => {
    this.shared++;
  };
}

export class FakeResolver implements SpaceResolver {
  spaces = new Map<string, FakeSpace>();
  resolves = 0;
  space(to: string): FakeSpace {
    let s = this.spaces.get(to);
    if (!s) {
      s = new FakeSpace(`any;-;${to}`);
      this.spaces.set(to, s);
    }
    return s;
  }
  async resolve(to: E164) {
    this.resolves++;
    return this.space(to);
  }
}

export class FakeFocus implements FocusApi {
  silenced = new Set<string>();
  notified: { chat: string; message: string }[] = [];
  addresses = { isFocusSilenced: async (a: string) => this.silenced.has(a) };
  messages = {
    notifySilenced: async (chat: string, message: string) => {
      this.notified.push({ chat, message });
    },
  };
}

export interface LogLine {
  level: string;
  obj: Record<string, unknown>;
  msg?: string | undefined;
}
export function recLogger(lines: LogLine[] = []) {
  const mk = (level: string) => (obj: Record<string, unknown>, msg?: string) => void lines.push({ level, obj, msg });
  return { lines, debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") };
}

export function seededStore(state: PlanState = "ACTIVE"): { store: Store; plan: EnginePlan; userId: string; guardianId: string } {
  const store = openStore(":memory:");
  repo.createUser(store, { addressE164: USER, displayName: "Alex", now: T0, id: "user-1" });
  const g = repo.upsertGuardian(store, { addressE164: GUARDIAN, displayName: "Priya", now: T0 });
  const plan = repo.insertPlan(store, basePlan({ guardianId: g.id, state }));
  return { store, plan, userId: "user-1", guardianId: g.id };
}

export function makeChannel(store: Store, clock: FakeClock, extra: Partial<ConstructorParameters<typeof GatewayChannel>[0]> = {}) {
  const resolver = new FakeResolver();
  const focus = new FakeFocus();
  const stopped = new Set<string>();
  const sleeps: number[] = [];
  const log = recLogger();
  const channel = new GatewayChannel({
    store,
    clock,
    resolver,
    focus,
    isStopped: (a) => stopped.has(a),
    logger: log,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { channel, resolver, focus, stopped, sleeps, log };
}

export const fakeRender = (id: TemplateId, params: Record<string, unknown>): string => {
  const fix = (params.fix ?? params.lastFix) as { lat: number; lng: number } | undefined;
  return fix ? `${id} https://maps.apple.com/?ll=${fix.lat},${fix.lng}` : id;
};

export function makeExecutor(store: Store, clock: FakeClock, opts: Partial<ExecutorOptions> = {}) {
  const ch = makeChannel(store, clock);
  const placed: { to: string; script: string }[] = [];
  let placeImpl: (to: E164, script: string) => Promise<boolean> = async () => true;
  const executor = new GatewayExecutor({
    store,
    clock,
    channel: ch.channel,
    calls: {
      place: async (to, script) => {
        placed.push({ to, script });
        return placeImpl(to, script);
      },
    },
    speech: false,
    render: fakeRender,
    logger: ch.log,
    ...opts,
  });
  return {
    ...ch,
    executor,
    placed,
    setPlace(fn: (to: E164, script: string) => Promise<boolean>) {
      placeImpl = fn;
    },
  };
}

export { FakeClock, T0 };
