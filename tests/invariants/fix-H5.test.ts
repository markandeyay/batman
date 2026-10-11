// H5 (I5, I16, 6.6, 10.4): calls never block. The runtime sends every text effect first (the
// guardian alert before any call), runs place() in the background with a hard timeout, keeps
// the per-plan queue and the scheduler free, and reports the result back as a call_result event
// (fake call fallback text, honest "or a call" in guardian copy).
import { afterEach, describe, expect, it } from "vitest";
import type { CallService, E164, Effect } from "../../apps/server/src/contracts.js";
import { renderTemplate } from "../../apps/server/src/notify/templates.js";
import { PlanRuntime, type OutboundPort } from "../../apps/server/src/plan/runtime.js";
import { applyEvent } from "../../apps/server/src/plan/stateMachine.js";
import type { EnginePlan } from "../../apps/server/src/plan/types.js";
import { openStore, type Store } from "../../apps/server/src/store/db.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { FakeClock } from "../../apps/server/src/util/clock.js";
import { at, basePlan, ctxAt, T0 } from "../unit/core/helpers.js";
import { makeExecutor } from "../unit/integration/gatewayHelpers.js";

const USER = "+13125550100" as E164;
const GUARDIAN = "+19195550142" as E164;

function seed(state: EnginePlan["state"] = "ACTIVE", extra: Partial<EnginePlan> = {}): { store: Store; plan: EnginePlan } {
  const store = openStore(":memory:");
  repo.createUser(store, { addressE164: USER, displayName: "Alex", tz: "America/New_York", onboardingStep: "done", now: T0, id: "user-1" });
  const g = repo.upsertGuardian(store, { addressE164: GUARDIAN, displayName: "Priya", now: T0 });
  repo.setGuardianLink(store, { userId: "user-1", guardianId: g.id, status: "accepted", now: T0 });
  const plan = repo.insertPlan(store, basePlan({ guardianId: g.id, state, shareConfirmedAt: at(-20), ...extra }));
  return { store, plan };
}

interface Rec {
  log: string[];
  port: OutboundPort;
  resolveCalls: (placed: boolean) => void;
}

/** A recording port whose calls hang until resolveCalls() (or forever). */
function hangingPort(): Rec {
  const log: string[] = [];
  const waiting: Array<(b: boolean) => void> = [];
  let n = 0;
  const port: OutboundPort = {
    send: async (e) => {
      log.push(`send:${e.to}:${e.template}`);
      return { id: `out-${++n}`, at: T0 };
    },
    react: async () => void log.push("react"),
    call: (e) => {
      log.push(`call:${e.to}:${e.script}`);
      return new Promise<boolean>((r) => waiting.push(r));
    },
    requestLocation: async () => void log.push("request_location"),
    startWatch: async () => void log.push("start_watch"),
    stopWatch: async () => void log.push("stop_watch"),
  };
  return { log, port, resolveCalls: (b) => waiting.splice(0).forEach((r) => r(b)) };
}

const runtimes: PlanRuntime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.idle();
});

function runtime(store: Store, port: OutboundPort, callTimeoutMs = 60_000): PlanRuntime {
  const clock = new FakeClock(at(30));
  const r = new PlanRuntime({ store, clock, jobs: { enqueue: () => 0, cancel: () => 0 }, out: port, defaultTz: "America/New_York", callTimeoutMs });
  runtimes.push(r);
  return r;
}

describe("H5 calls never block", () => {
  it("distress: the guardian alert text goes out before any call, and dispatch does not wait for place()", async () => {
    const { store, plan } = seed();
    const rec = hangingPort();
    const rt = runtime(store, rec.port);
    await rt.dispatch(plan.id, { type: "distress", messageId: "m1" }); // resolves although calls hang
    const firstCall = rec.log.findIndex((l) => l.startsWith("call:"));
    expect(rec.log.indexOf("send:guardian:gdn_alert")).toBeGreaterThanOrEqual(0);
    expect(rec.log.indexOf("send:guardian:gdn_alert")).toBeLessThan(firstCall);
    expect(rec.log.slice(firstCall)).toEqual(["call:user:fake", "call:guardian:guardian_alert"]);
    rec.resolveCalls(true);
  });

  it("the per-plan queue stays free while a call hangs", async () => {
    const { store, plan } = seed();
    const rec = hangingPort();
    const rt = runtime(store, rec.port);
    await rt.dispatch(plan.id, { type: "exit_word", messageId: "m1" });
    await rt.dispatch(plan.id, { type: "user_command", command: "extend", minutes: 30 });
    expect(rec.log).toContain("send:user:act_extend_confirm");
    rec.resolveCalls(true);
  });

  it("a hung place() times out and counts as not placed: fake call falls back to the text", async () => {
    const { store, plan } = seed();
    const rec = hangingPort();
    const rt = runtime(store, rec.port, 30);
    await rt.dispatch(plan.id, { type: "exit_word", messageId: "m1" });
    await rt.idle();
    expect(rec.log).toEqual(["send:user:cw_exit_reply", "call:user:fake", "send:user:cw_call_fallback_text"]);
    expect(repo.listPlanEvents(store, plan.id).map((e) => e.kind)).toEqual(expect.arrayContaining(["call_fallback"]));
  });

  it("a placed fake call sends no fallback; exactly one fallback when it fails", async () => {
    for (const placed of [true, false]) {
      const { store, plan } = seed();
      const rec = hangingPort();
      const rt = runtime(store, rec.port);
      await rt.dispatch(plan.id, { type: "exit_word", messageId: "m1" });
      rec.resolveCalls(placed);
      await rt.idle();
      expect(rec.log.filter((l) => l === "send:user:cw_call_fallback_text")).toHaveLength(placed ? 0 : 1);
    }
  });

  it("the executor reports the real place() result and sends no fallback of its own", async () => {
    const { store, plan } = seed();
    const t = makeExecutor(store, new FakeClock(T0));
    t.setPlace(async () => false);
    expect(await t.executor.call({ kind: "call", to: "user", script: "fake" }, plan)).toBe(false);
    expect(t.resolver.space(USER).sent).toEqual([]);
  });
});

describe("H5 call_result makes guardian copy honest", () => {
  type Send = Extract<Effect, { kind: "send" }>;
  const l2 = basePlan({
    state: "CHECKING",
    shareConfirmedAt: at(-20),
    ladderStep: "L2",
    ladderClass: "overtime",
    ladderTrigger: "T-OVR",
    ladderStartedAt: at(135),
    ladderStepAt: at(150),
    ladderMessages: 3,
  });
  const alertText = (p: EnginePlan) => {
    const r = applyEvent(p, { type: "timer", job: "ladder", payload: { step: "L3", token: at(135).toISOString() } }, ctxAt(at(153)));
    const s = r.effects.find((e): e is Send => e.kind === "send" && e.template === "gdn_alert")!;
    return renderTemplate(s.template, s.params ?? {}, { variant: 0 });
  };
  it("placed check-in call: 'or a call'; failed or unknown: no call claimed", () => {
    const placed = applyEvent(l2, { type: "call_result", script: "checkin", placed: true }, ctxAt(at(150))).plan;
    expect(alertText(placed)).toContain("hasn't answered my last 3 messages or a call (18 min)");
    const failed = applyEvent(l2, { type: "call_result", script: "checkin", placed: false }, ctxAt(at(150))).plan;
    expect(alertText(failed)).not.toContain("or a call");
    expect(alertText(l2)).not.toContain("or a call");
  });

  it("call_result for a fake call that failed sends the fallback text once (6.6 step 3)", () => {
    const r = applyEvent(basePlan({ state: "ACTIVE" }), { type: "call_result", script: "fake", placed: false }, ctxAt(at(30)));
    const sends = r.effects.filter((e): e is Send => e.kind === "send");
    expect(sends.map((s) => [s.template, s.notifyAnyway, s.critical])).toEqual([["cw_call_fallback_text", true, true]]);
  });

  it("CallService type is unchanged (place returns a boolean)", () => {
    const svc: CallService = { place: async () => true };
    expect(typeof svc.place).toBe("function");
  });
});
