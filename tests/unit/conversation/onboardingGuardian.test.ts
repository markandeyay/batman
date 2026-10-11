import { describe, expect, it } from "vitest";
import { handleOptinExpire } from "../../../apps/server/src/dialogue/guardian.js";
import { parseName } from "../../../apps/server/src/dialogue/onboarding.js";
import { GUARDIAN, GUARDIAN_POOL, USER, makeHarness, seedPlan, seedUser } from "./helpers.js";

async function onboard(h: ReturnType<typeof makeHarness>) {
  await h.text(USER, "hey");
  await h.text(USER, "Alex");
  await h.inbound(USER, { kind: "contact", name: "Priya", phones: ["+1 919 555 0142"] });
  await h.text(USER, "exit pineapple, alert blue moon");
}

describe("onboarding (4.2)", () => {
  it("runs the full flow in spec order", async () => {
    const h = makeHarness();
    await onboard(h);
    expect(h.sentTo(USER).map((s) => s.template)).toEqual([
      "onb_hello",
      "onb_ask_name",
      "onb_ask_guardian",
      "onb_guardian_text_first",
      "onb_ask_codewords",
      "onb_save_contact",
      "onb_disclosure_done",
    ]);
    expect(h.contactCards).toEqual([USER]);
    const u = (await h.repo.getUserByAddress(USER))!;
    expect(u).toMatchObject({ displayName: "Alex", onboardingStep: "done" });
    expect(await h.repo.getCodeWords(u.id)).toEqual({ exit: "pineapple", alert: "blue moon" });
  });

  it("shared pool: registers the guardian, never texts them first, never checks iMessage availability", async () => {
    const h = makeHarness();
    await onboard(h);
    expect(h.registered).toEqual([GUARDIAN]);
    expect(h.sentTo(GUARDIAN)).toEqual([]);
    expect(h.iMessageChecks).toEqual([]);
    const tf = h.sentTo(USER).find((s) => s.template === "onb_guardian_text_first")!;
    expect(tf.params).toMatchObject({ guardianName: "Priya", assignedNumber: GUARDIAN_POOL });
    expect(tf.text).toContain("(628) 555-0100");
    // 48 h expiry starts when the user names the guardian.
    expect(h.scheduled[0]).toMatchObject({ kind: "optin_expire", planId: null });
    expect(h.scheduled[0]!.runAt.getTime() - h.clock.now().getTime()).toBe(48 * 3600_000);
  });

  it("guardian's first text triggers the opt-in request, then YES/NO works", async () => {
    const h = makeHarness();
    await onboard(h);
    h.clear();
    expect(await h.text(GUARDIAN, "hi")).toBe("guardian_optin_sent");
    expect(h.sentTo(GUARDIAN).map((s) => s.template)).toEqual(["gdn_optin_request"]);
    expect(h.sentTo(GUARDIAN)[0]!.text).toContain("Alex added you as their backup");
    expect(await h.text(GUARDIAN, "YES")).toBe("guardian_accept");
    expect(h.sentTo(GUARDIAN).map((s) => s.template)).toEqual(["gdn_optin_request", "gdn_optin_thanks"]);
    expect(h.sentTo(USER).map((s) => s.template)).toEqual(["usr_guardian_in"]);
    expect(h.repo.links[0]!.status).toBe("accepted");
  });

  it("a YES sent before the request was seen only unlocks the request", async () => {
    const h = makeHarness();
    await onboard(h);
    h.clear();
    await h.text(GUARDIAN, "yes");
    expect(h.repo.links[0]!.status).toBe("pending");
    expect(h.sentTo(GUARDIAN).map((s) => s.template)).toEqual(["gdn_optin_request"]);
  });

  it("is resumable from the persisted step", async () => {
    const h = makeHarness();
    await h.text(USER, "hi");
    await h.text(USER, "I'm alex");
    const u = (await h.repo.getUserByAddress(USER))!;
    expect(u.onboardingStep).toBe("ask_guardian");
    h.clear();
    await h.text(USER, "Priya 919 555 0142");
    expect(h.sentTo(USER).map((s) => s.template)).toEqual(["onb_guardian_text_first", "onb_ask_codewords"]);
  });

  it("rejects the user's own number and junk, and re-asks bad code words in one line", async () => {
    const h = makeHarness();
    await h.text(USER, "hi");
    await h.text(USER, "Alex");
    h.clear();
    await h.text(USER, "me 312 555 0101");
    expect(h.sent[0]).toMatchObject({ template: "onb_guardian_invalid", params: { reasonId: "own_number" } });
    await h.text(USER, "my sister");
    expect(h.sent[1]).toMatchObject({ template: "onb_guardian_invalid", params: { reasonId: "no_number" } });
    await h.text(USER, "Priya 919 555 0142");
    h.clear();
    await h.text(USER, "exit ok alert yes");
    expect(h.sent[0]).toMatchObject({ template: "onb_codewords_invalid" });
    expect(h.sent[0]!.text.split("\n").length).toBe(1);
    await h.text(USER, "exit zebra alert cobra");
    expect(h.sent[1]).toMatchObject({ params: { reasonId: "too_similar" } });
  });

  it("reports an unreachable guardian when registration fails", async () => {
    const h = makeHarness({ registration: null });
    await h.text(USER, "hi");
    await h.text(USER, "Alex");
    await h.text(USER, "Priya 919 555 0142");
    expect(h.sent.at(-1)).toMatchObject({ template: "onb_guardian_invalid", params: { reasonId: "unreachable" } });
  });

  it("parses names", () => {
    expect(parseName("alex")).toBe("Alex");
    expect(parseName("I'm Sam Lee!")).toBe("Sam Lee");
    expect(parseName("my name is Jo")).toBe("Jo");
    expect(parseName("919 555 0142")).toBeNull();
    expect(parseName("hey I have a date tonight at the cafe")).toBeNull();
  });
});

describe("guardian dialogue (4.3, 5.4)", () => {
  it("NO declines and tells the user", async () => {
    const h = makeHarness();
    await onboard(h);
    await h.text(GUARDIAN, "hi");
    h.clear();
    await h.text(GUARDIAN, "no");
    expect(h.repo.links[0]!.status).toBe("declined");
    expect(h.sentTo(GUARDIAN)[0]!.template).toBe("gdn_optin_declined_ack");
    expect(h.sentTo(USER)[0]!.template).toBe("usr_guardian_declined");
  });

  it("opt-in expires after 48 h and the user is told", async () => {
    const h = makeHarness();
    await onboard(h);
    const u = (await h.repo.getUserByAddress(USER))!;
    const link = h.repo.links[0]!;
    h.clear();
    await handleOptinExpire(h.ports, { userId: u.id, guardianId: link.guardianId });
    expect(h.sent).toEqual([]); // too early
    h.clock.advance(48 * 3600_000 + 1);
    await handleOptinExpire(h.ports, { userId: u.id, guardianId: link.guardianId });
    expect(h.repo.links[0]!.status).toBe("expired");
    expect(h.sentTo(USER)[0]!.template).toBe("usr_guardian_expired");
  });

  it("one guardian, two users, separate consent records", async () => {
    const h = makeHarness();
    const a = await seedUser(h, { name: "Alex", guardian: "accepted" });
    const b = await h.repo.createUser("+13125550199", h.clock.now());
    await h.repo.updateUser(b.id, { displayName: "Sam", onboardingStep: "done" });
    await h.text("+13125550199", "change backup");
    await h.text("+13125550199", "Priya 919 555 0142");
    // Priya already texted Batman (accepted for Alex), so the request goes out now.
    expect(h.sentTo(GUARDIAN).map((s) => s.template)).toEqual(["gdn_optin_request"]);
    expect(h.sentTo(GUARDIAN)[0]!.text).toContain("Sam added you");
    await h.text(GUARDIAN, "yes");
    expect((await h.repo.getLink(b.id, a.guardianId!))!.status).toBe("accepted");
    expect((await h.repo.getLink(a.user.id, a.guardianId!))!.status).toBe("accepted");
  });

  it("escalation commands map to engine events", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ESCALATED");
    await h.text(GUARDIAN, "GOT IT");
    await h.text(GUARDIAN, "where is she");
    expect(h.dispatched.map((d) => d.event.type)).toEqual(["guardian_ack", "guardian_location_request"]);
    expect(h.dispatched.every((d) => d.planId === plan.id)).toBe(true);
  });

  it("'call her' during a window asks the engine for a check-in call", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ACTIVE");
    await h.text(GUARDIAN, "can you call her");
    expect(h.dispatched.map((d) => d.event.type)).toEqual(["guardian_call_request"]);
  });

  it("'where' outside an alert is refused", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ACTIVE");
    await h.text(GUARDIAN, "where is she");
    expect(h.dispatched).toEqual([]);
    expect(h.sentTo(GUARDIAN)[0]!.template).toBe("gdn_location_denied");
  });

  it("guardian keywords win over the person's own user role when they have an obligation (8.4 step 5)", async () => {
    const h = makeHarness();
    const alex = await seedUser(h, { name: "Alex" });
    const plan = await seedPlan(h, alex.user.id, alex.guardianId, "ESCALATED");
    // Priya is also a Batman user with her own plan.
    const priyaUser = await h.repo.createUser(GUARDIAN, h.clock.now());
    await h.repo.updateUser(priyaUser.id, { displayName: "Priya", onboardingStep: "done" });
    await h.text(GUARDIAN, "on it");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "guardian_ack" } }]);
  });
});
