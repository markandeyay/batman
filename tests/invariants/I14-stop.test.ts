// I14. Stop means stop: STOP from anyone immediately stops all messages to that person. The user
// can end any plan at any time with "cancel" or "done".
import { describe, expect, it } from "vitest";
import { PLAN_STATES, TERMINAL_STATES, WINDOW_STATES } from "../../apps/server/src/contracts.js";
import { GUARDIAN, USER, makeHarness, seedPlan, seedUser } from "../unit/conversation/helpers.js";

describe("I14 stop", () => {
  it("user STOP: one ack, plan cancelled, nothing else sent", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ARMED");
    await h.text(USER, "STOP");
    expect(h.sentTo(USER).map((s) => s.template)).toEqual(["stop_ack"]);
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "user_command", command: "cancel" } }]);
    expect(await h.repo.isStopped(USER)).toBe(true);
    // Repeated STOP sends nothing more.
    await h.text(USER, "stop");
    expect(h.sentTo(USER).length).toBe(1);
  });

  it("guardian STOP: ack, links revoked, user told, nothing more to the guardian", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ESCALATED");
    await h.text(GUARDIAN, "stop");
    expect(h.sentTo(GUARDIAN).map((s) => s.template)).toEqual(["stop_ack"]);
    expect(h.dispatched).toContainEqual({ planId: plan.id, event: { type: "guardian_stop" } });
    expect(h.repo.links[0]!.status).toBe("revoked");
    expect(h.sentTo(USER).map((s) => s.template)).toEqual(["usr_guardian_stopped"]);
    // Later guardian texts and new opt-in attempts produce no messages to the guardian.
    await h.text(GUARDIAN, "where is she");
    await h.text(GUARDIAN, "yes");
    await h.text(USER, "change backup");
    await h.text(USER, "Priya 919 555 0142");
    expect(h.sentTo(GUARDIAN).length).toBe(1);
    expect(h.sentTo(USER).at(-1)).toMatchObject({ template: "onb_guardian_invalid", params: { reasonId: "stopped" } });
  });

  it("a stopped guardian can opt back in with START", async () => {
    const h = makeHarness();
    await seedUser(h);
    await h.text(GUARDIAN, "stop");
    await h.text(GUARDIAN, "start");
    expect(await h.repo.isStopped(GUARDIAN)).toBe(false);
  });

  it.each(PLAN_STATES.filter((s) => !TERMINAL_STATES.includes(s)).map((s) => [s]))("cancel ends a %s plan", async (state) => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, state);
    await h.text(USER, "cancel");
    expect(h.dispatched).toContainEqual({ planId: plan.id, event: { type: "user_command", command: "cancel" } });
  });

  it("done in PRE_MEETUP asks once, then YES ends the plan (M7)", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "PRE_MEETUP");
    await h.text(USER, "done");
    expect(h.sentTo(USER).at(-1)?.template).toBe("plan_cancel_confirm_ask");
    await h.text(USER, "yes");
    expect(h.dispatched).toContainEqual({ planId: plan.id, event: { type: "user_command", command: "cancel" } });
  });

  it.each(WINDOW_STATES.filter((s) => s !== "PRE_MEETUP").map((s) => [s]))("done is passed to the engine in %s", async (state) => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, state);
    await h.text(USER, "done");
    expect(h.dispatched).toContainEqual({ planId: plan.id, event: { type: "user_command", command: "done" } });
  });
});
