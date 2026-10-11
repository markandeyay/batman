// Spec 16.1: control port exists only with TEST_MODE=1, binds loopback only, leaks no code words.
import { afterEach, describe, expect, it } from "vitest";
import { createControlPort, isLoopback, type ControlPort } from "../../../apps/server/src/testing/controlPort.js";
import * as repo from "../../../apps/server/src/store/repo.js";
import { GUARDIAN, T0, USER, seededStore } from "./gatewayHelpers.js";

let port: ControlPort | null = null;
afterEach(async () => {
  await port?.close();
  port = null;
});

describe("control port", () => {
  it("is disabled without TEST_MODE", () => {
    const { store } = seededStore();
    expect(createControlPort({ TEST_MODE: false, TEST_CONTROL_PORT: 0 }, { store })).toBeNull();
  });

  it("binds 127.0.0.1 only and rejects non-loopback peers", async () => {
    const { store } = seededStore();
    port = createControlPort({ TEST_MODE: true, TEST_CONTROL_PORT: 0 }, { store })!;
    const a = await port.listen();
    expect(a.host).toBe("127.0.0.1");
    expect(isLoopback("192.168.1.5")).toBe(false);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("GET /state and /outbox expose ids and template ids, never code words or full numbers", async () => {
    const { store, plan } = seededStore("ACTIVE");
    repo.setCodeWords(store, "user-1", "pineapple", "red balloon");
    repo.recordMessage(store, { platformMessageId: "spc-msg-1", direction: "outbound", addressE164: USER, planId: plan.id, kind: "act_mid_check", bodyRedacted: "Hey, how is it going?", sentAt: T0 });
    repo.recordMessage(store, { platformMessageId: "spc-msg-2", direction: "outbound", addressE164: GUARDIAN, planId: plan.id, kind: "gdn_alert", bodyRedacted: "Alex hasn't replied [code]", sentAt: T0 });
    let ff = 0;
    port = createControlPort({ TEST_MODE: true, TEST_CONTROL_PORT: 0 }, { store, fastForward: (m) => void (ff += m) })!;
    const { port: p } = await port.listen();
    const base = `http://127.0.0.1:${p}`;
    const state = (await (await fetch(`${base}/state?user=${encodeURIComponent(USER)}`)).json()) as { plan: { state: string }; lastOutbound: { template: string }[] };
    expect(state.plan.state).toBe("ACTIVE");
    expect(state.lastOutbound.map((m: { template: string }) => m.template).sort()).toEqual(["act_mid_check", "gdn_alert"]);
    const outbox = (await (await fetch(`${base}/outbox?since=${encodeURIComponent(T0.toISOString())}`)).json()) as { messages: unknown[] };
    expect(outbox.messages).toHaveLength(2);
    const all = JSON.stringify([state, outbox]);
    expect(all).not.toMatch(/pineapple|red balloon/i);
    expect(all).not.toContain(USER);
    expect(all).not.toContain(GUARDIAN);
    const r = await fetch(`${base}/ff`, { method: "POST", body: JSON.stringify({ minutes: 30 }) });
    expect(r.status).toBe(200);
    expect(ff).toBe(30);
    expect((await fetch(`${base}/ff`, { method: "POST", body: JSON.stringify({ minutes: -1 }) })).status).toBe(400);
    expect((await fetch(`${base}/replay`, { method: "POST", body: JSON.stringify({ track: "date-normal" }) })).status).toBe(501);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("POST /reset deletes the test user's data", async () => {
    const { store } = seededStore("DRAFT");
    port = createControlPort({ TEST_MODE: true, TEST_CONTROL_PORT: 0 }, { store })!;
    const { port: p } = await port.listen();
    const r = await fetch(`http://127.0.0.1:${p}/reset`, { method: "POST", body: JSON.stringify({ user: USER }) });
    expect(await r.json()).toEqual({ ok: true, deleted: true });
    expect(repo.getUserByAddress(store, USER)).toBeNull();
  });
});
