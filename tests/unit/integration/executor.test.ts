// Gateway executor: every Effect kind, the 5 s exit-call fallback (spec 6.6 step 3), guardian
// alert call skipped without speech, stop checks (I14), and PlanRuntime integration.
import { describe, expect, it } from "vitest";
import type { E164, Fix, LocationSource } from "../../../apps/server/src/contracts.js";
import { TargetNotAllowedError } from "../../../apps/server/src/gateway/errors.js";
import { maskForStorage } from "../../../apps/server/src/gateway/executor.js";
import { PlanRuntime } from "../../../apps/server/src/plan/runtime.js";
import * as repo from "../../../apps/server/src/store/repo.js";
import { FakeClock, GUARDIAN, T0, TARGET_NOT_ALLOWED, USER, makeExecutor, seededStore } from "./gatewayHelpers.js";

const events = (store: ReturnType<typeof seededStore>["store"], planId: string) => repo.listPlanEvents(store, planId).map((e) => e.kind);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("GatewayExecutor effects", () => {
  it("send renders, sends to the right recipient, writes audit + redacted row, notifyAnyway when Focus is on", async () => {
    const { store, plan } = seededStore("CHECKING");
    const clock = new FakeClock(T0);
    const t = makeExecutor(store, clock);
    t.focus.silenced.add(USER);
    const ref = await t.executor.send({ kind: "send", to: "user", template: "lad_l1", notifyAnyway: true, track: true }, plan);
    expect(ref?.id).toMatch(/^spc-msg-/);
    expect(t.resolver.space(USER).sent).toEqual(["lad_l1"]);
    expect(t.focus.notified).toHaveLength(1);
    expect(events(store, plan.id)).toContain("outbound");
    const row = store.sqlite.prepare("SELECT kind, plan_id FROM messages WHERE direction='outbound'").get();
    expect(row).toEqual({ kind: "lad_l1", plan_id: plan.id });
  });

  it("masks code words as [code] in stored bodies", async () => {
    const { store, plan } = seededStore("ACTIVE");
    repo.setCodeWords(store, "user-1", "pineapple", "red balloon");
    const t = makeExecutor(store, new FakeClock(T0), { render: () => "your words are pineapple and Red Balloon" });
    await t.executor.send({ kind: "send", to: "user", template: "onb_disclosure_done" }, plan);
    const row = store.sqlite.prepare("SELECT body_redacted FROM messages WHERE direction='outbound'").get() as { body_redacted: string };
    expect(row.body_redacted).toBe("your words are [code] and [code]");
    expect(maskForStorage("at 41.917200,-87.706700 now", [])).toBe("at [loc] now");
  });

  it("I14: drops sends to a stopped guardian and to any stopped address, logged and audited", async () => {
    const { store, plan, guardianId } = seededStore("ESCALATED");
    const t = makeExecutor(store, new FakeClock(T0));
    repo.markGuardianStopped(store, guardianId, T0);
    expect(await t.executor.send({ kind: "send", to: "guardian", template: "gdn_alert", critical: true }, plan)).toBeNull();
    t.stopped.add(USER);
    expect(await t.executor.send({ kind: "send", to: "user", template: "lad_l1" }, plan)).toBeNull();
    expect(t.resolver.spaces.size).toBe(0);
    expect(events(store, plan.id).filter((e) => e === "send_dropped_stopped")).toHaveLength(2);
    expect(await t.executor.sendTextTo(USER, "free text")).toBeNull();
  });

  it("dialogue sendText/sendTemplate surface TargetNotAllowedError (guardian has not texted first)", async () => {
    const { store } = seededStore("DRAFT");
    const t = makeExecutor(store, new FakeClock(T0));
    t.resolver.space(GUARDIAN).failures.push(TARGET_NOT_ALLOWED);
    await expect(t.executor.sendTemplateTo(GUARDIAN, "gdn_optin_request")).rejects.toBeInstanceOf(TargetNotAllowedError);
  });

  it("react goes through the channel's remembered message", async () => {
    const { store, plan } = seededStore("ACTIVE");
    const t = makeExecutor(store, new FakeClock(T0));
    const got: string[] = [];
    t.channel.rememberInbound("spc-msg-in", { react: async (e) => void got.push(e) });
    await t.executor.react({ kind: "react", messageId: "spc-msg-in", emoji: "like" }, plan);
    expect(got).toEqual(["👍"]);
  });

  it("fake exit call never blocks the runtime; place() false sends cw_call_fallback_text within 5 s of that result (H5)", async () => {
    const { store, plan } = seededStore("ACTIVE");
    const clock = new FakeClock(T0);
    const t = makeExecutor(store, clock);
    const d = deferred<boolean>();
    t.setPlace(() => d.promise);
    const runtime = new PlanRuntime({ store, clock, jobs: { enqueue: () => 0, cancel: () => 0 }, out: t.executor, defaultTz: "America/New_York" });
    await runtime.dispatch(plan.id, { type: "exit_word", messageId: "spc-msg-in" }); // returns before place() resolved
    expect(t.placed).toEqual([{ to: USER, script: "fake" }]);
    const resolvedAt = Date.now();
    d.resolve(false); // e.g. SIP 403 after about 1.3 s on the shared pool
    await runtime.idle();
    expect(Date.now() - resolvedAt).toBeLessThan(5000);
    expect(t.resolver.space(USER).sent).toEqual(["cw_exit_reply", "cw_call_fallback_text"]);
    expect(events(store, plan.id)).toEqual(expect.arrayContaining(["call_started", "call_placed", "call_result", "call_fallback", "outbound"]));
  });

  it("place() true sends no fallback; a throwing CallService counts as not placed", async () => {
    const { store, plan } = seededStore("ACTIVE");
    const clock = new FakeClock(T0);
    const t = makeExecutor(store, clock);
    const runtime = new PlanRuntime({ store, clock, jobs: { enqueue: () => 0, cancel: () => 0 }, out: t.executor, defaultTz: "America/New_York" });
    expect(await t.executor.call({ kind: "call", to: "user", script: "fake" }, plan)).toBe(true);
    await runtime.dispatch(plan.id, { type: "exit_word", messageId: "m1" });
    await runtime.idle();
    expect(t.resolver.space(USER).sent).toEqual(["cw_exit_reply"]);
    t.setPlace(async () => {
      throw new Error("boom");
    });
    expect(await t.executor.call({ kind: "call", to: "user", script: "fake" }, plan)).toBe(false);
    await runtime.dispatch(plan.id, { type: "exit_word", messageId: "m2" });
    await runtime.idle();
    expect(t.resolver.space(USER).sent.filter((x) => x === "cw_call_fallback_text")).toHaveLength(1);
  });

  it("checkin call failure sends no fallback (the engine already sends lad_l2_text)", async () => {
    const { store, plan } = seededStore("CHECKING");
    const t = makeExecutor(store, new FakeClock(T0));
    t.setPlace(async () => false);
    await t.executor.call({ kind: "call", to: "user", script: "checkin" }, plan);
    await t.executor.idle();
    expect(t.resolver.space(USER).sent).toEqual([]);
  });

  it("guardian_alert call is skipped when speech is off, placed when on", async () => {
    const { store, plan } = seededStore("ESCALATED");
    const off = makeExecutor(store, new FakeClock(T0));
    expect(await off.executor.call({ kind: "call", to: "guardian", script: "guardian_alert" }, plan)).toBe(false);
    expect(off.placed).toEqual([]);
    const on = makeExecutor(store, new FakeClock(T0), { speech: true });
    expect(await on.executor.call({ kind: "call", to: "guardian", script: "guardian_alert" }, plan)).toBe(true);
    await on.executor.idle();
    expect(on.placed).toEqual([{ to: GUARDIAN, script: "guardian_alert" }]);
  });

  it("request_location calls im.locations.request for the plan's own user with an idempotency key", async () => {
    const { store, plan } = seededStore("PRE_MEETUP");
    const reqs: unknown[][] = [];
    const t = makeExecutor(store, new FakeClock(T0), {
      locations: { request: async (...a: unknown[]) => (reqs.push(a), { status: "sent", messageGuid: "spc-msg-card" }) },
    });
    await t.executor.requestLocation(plan);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]![0]).toBe(`any;-;${USER}`);
    expect(reqs[0]![1]).toBe(USER);
    expect((reqs[0]![2] as { clientMessageId: string }).clientMessageId).toMatch(new RegExp(`^loc-${plan.id}-`));
    expect(events(store, plan.id)).toContain("location_requested");
  });

  it("start_watch/stop_watch run one LocationSource per plan and feed fixes to the runtime sink", async () => {
    const { store, plan } = seededStore("ACTIVE");
    let emit: ((f: Fix, from: E164) => void) | null = null;
    let stopped = 0;
    let shareEnded: (() => void) | null = null;
    const src: LocationSource = {
      start: async (_a, onFix) => void (emit = onFix),
      stop: async () => void stopped++,
    };
    const t = makeExecutor(store, new FakeClock(T0), {
      createLocationSource: (_p, addr, hooks) => {
        expect(addr).toBe(USER);
        shareEnded = hooks.onShareEnded;
        return src;
      },
    });
    const ingested: string[] = [];
    const dispatched: string[] = [];
    t.executor.bind({ ingestFix: async (id) => void ingested.push(id), dispatch: async (_id, e) => void dispatched.push(e.type) });
    await t.executor.startWatch(plan);
    await t.executor.startWatch(plan); // idempotent
    emit!({ lat: 1, lng: 2, accuracyM: 10, at: T0, locationType: "shallow", expiresAt: null, source: "findmy" }, USER);
    shareEnded!();
    await t.executor.stopWatch(plan);
    emit!({ lat: 1, lng: 2, accuracyM: 10, at: T0, locationType: "shallow", expiresAt: null, source: "findmy" }, USER);
    expect(ingested).toEqual([plan.id]);
    expect(dispatched).toEqual(["location_not_shared"]);
    expect(stopped).toBe(1);
  });
});

describe("executor with PlanRuntime", () => {
  it("exit word: innocuous reply first, no double fallback, fallback right after place() fails", async () => {
    const { store, plan } = seededStore("ACTIVE");
    const clock = new FakeClock(T0);
    const t = makeExecutor(store, clock);
    const d = deferred<boolean>();
    t.setPlace(() => d.promise);
    const runtime = new PlanRuntime({ store, clock, jobs: { enqueue: () => 0, cancel: () => 0 }, out: t.executor, defaultTz: "America/New_York" });
    t.executor.bind({ ingestFix: (id, f) => runtime.ingestFix(id, f), dispatch: (id, e) => runtime.dispatch(id, e) });
    await runtime.dispatch(plan.id, { type: "exit_word", messageId: "spc-msg-in" });
    expect(t.resolver.space(USER).sent).toEqual(["cw_exit_reply"]); // dispatch finished before place() resolved
    d.resolve(false);
    await runtime.idle();
    expect(t.resolver.space(USER).sent).toEqual(["cw_exit_reply", "cw_call_fallback_text"]);
  });

  it("ingested fixes outside a window are discarded (I3)", async () => {
    const { store, plan } = seededStore("ARMED");
    const clock = new FakeClock(T0);
    const t = makeExecutor(store, clock);
    const runtime = new PlanRuntime({ store, clock, jobs: { enqueue: () => 0, cancel: () => 0 }, out: t.executor, defaultTz: "America/New_York" });
    const ok = await runtime.ingestFix(plan.id, { lat: 41.9, lng: -87.7, accuracyM: 10, at: T0, locationType: "shallow", expiresAt: null, source: "findmy" });
    expect(ok).toBe(false);
    expect(repo.listFixes(store, plan.id)).toEqual([]);
  });
});

