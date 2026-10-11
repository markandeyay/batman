// M2 (I16): outbound effects are written to a durable outbox in the same transaction as the
// plan update, drained after commit, replayed on boot, and idempotent by effect id. A crash
// between saving ESCALATED and sending gdn_alert no longer loses the alert.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { E164 } from "../../apps/server/src/contracts.js";
import { PlanRuntime, type OutboundPort, type SendEffect } from "../../apps/server/src/plan/runtime.js";
import { openStore, type Store } from "../../apps/server/src/store/db.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { FakeClock } from "../../apps/server/src/util/clock.js";
import { at, basePlan, T0 } from "../unit/core/helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function seed(store: Store): string {
  repo.createUser(store, { addressE164: "+13125550100" as E164, displayName: "Alex", now: T0, id: "user-1" });
  const g = repo.upsertGuardian(store, { addressE164: "+19195550142" as E164, displayName: "Priya", now: T0 });
  repo.setGuardianLink(store, { userId: "user-1", guardianId: g.id, status: "accepted", now: T0 });
  return repo.insertPlan(store, basePlan({ guardianId: g.id, state: "ACTIVE", shareConfirmedAt: at(-20) })).id;
}

function port(onSend: (e: SendEffect) => Promise<unknown> = async () => undefined) {
  const sent: string[] = [];
  const calls: string[] = [];
  const p: OutboundPort = {
    send: async (e) => {
      await onSend(e);
      sent.push(`${e.to}:${e.template}`);
      return { id: `o${sent.length}`, at: T0 };
    },
    react: async () => {},
    call: async (e) => (calls.push(e.script), true),
    requestLocation: async () => {},
    startWatch: async () => {},
    stopWatch: async () => {},
  };
  return { p, sent, calls };
}

const rt = (store: Store, out: OutboundPort, now = at(30)) =>
  new PlanRuntime({ store, clock: new FakeClock(now), jobs: { enqueue: () => 0, cancel: () => 0 }, out, defaultTz: "America/New_York" });

describe("M2 durable outbox", () => {
  it("crash after saving ESCALATED but before gdn_alert: the alert goes out on boot, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batman-m2-"));
    dirs.push(dir);
    const db = join(dir, "batman.db");
    const a = openStore(db);
    const planId = seed(a);
    // The process "dies" while sending: the user reply goes out, the guardian send never completes.
    const hang = port((e) => (e.to === "guardian" ? new Promise(() => {}) : Promise.resolve()));
    void rt(a, hang.p).dispatch(planId, { type: "alert_word", messageId: "m1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(hang.sent).toEqual(["user:cw_alert_reply"]);
    expect(repo.getPlan(a, planId)!.state).toBe("ESCALATED");

    // Boot: a new process on the same database replays the outbox.
    const b = openStore(db);
    const boot = port();
    const r = rt(b, boot.p, at(31));
    await r.replayOutbox();
    await r.idle();
    expect(boot.sent).toEqual(["guardian:gdn_alert"]);
    expect(boot.calls).toEqual(["guardian_alert"]);
    // Idempotent: a second replay sends nothing more.
    await r.replayOutbox();
    await r.idle();
    expect(boot.sent).toEqual(["guardian:gdn_alert"]);
    b.close();
    a.close();
  });

  it("outbox rows are written in the same transaction as the plan update and marked done after delivery", async () => {
    const store = openStore(":memory:");
    const planId = seed(store);
    const out = port();
    const r = rt(store, out.p);
    await r.dispatch(planId, { type: "distress", messageId: "m1" });
    await r.idle();
    const rows = repo.listOutbox(store, planId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.status === "done")).toBe(true);
    await r.replayOutbox();
    await r.idle();
    expect(out.sent.filter((s) => s === "guardian:gdn_alert")).toHaveLength(1);
  });

  it("stale calls are not replayed on boot (a fake call long after the exit word helps no one)", async () => {
    const store = openStore(":memory:");
    const planId = seed(store);
    repo.insertOutbox(store, [{ id: "stale-call", planId, seq: 0, effect: { kind: "call", to: "user", script: "fake" }, createdAt: at(0) }]);
    const out = port();
    const r = rt(store, out.p, at(30));
    await r.replayOutbox();
    await r.idle();
    expect(out.calls).toEqual([]);
    expect(repo.listOutbox(store, planId)[0]!.status).toBe("done");
  });
});
