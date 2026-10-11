// I1. Consent: a guardian receives no plan details until they reply YES; a plan is armed only
// after the user replies "go".
import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../../apps/server/src/nlu/llm.js";
import { GUARDIAN, USER, makeHarness, seedPlan, seedUser } from "../unit/conversation/helpers.js";

const PLAN_DETAILS = ["Jordan", "Lula", "Hinge", "Kedzie", "7:00", "date", "maps.apple.com", "location"];

describe("I1 consent", () => {
  it("guardian sees only the opt-in request before YES, even while the user plans and texts code words", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h, { guardian: "pending" });
    h.repo.links[0]!.optinSentAt = null; // shared pool: guardian has not texted yet
    const plan = await seedPlan(h, user.id, guardianId, "DRAFT");
    await h.text(USER, "status");
    await h.text(GUARDIAN, "hi"); // unlocks the request
    await h.text(GUARDIAN, "where is she");
    await h.text(GUARDIAN, "call her");
    h.repo.setPlanState(plan.id, "ACTIVE");
    await h.text(GUARDIAN, "where is she");
    const toGuardian = h.sentTo(GUARDIAN);
    expect(toGuardian[0]!.template).toBe("gdn_optin_request");
    for (const s of toGuardian) for (const d of PLAN_DETAILS.filter((x) => x !== "location")) expect(s.text).not.toContain(d);
    // No plan-touching guardian events reached the engine for an unconsented guardian.
    expect(h.dispatched.filter((d) => d.event.type.startsWith("guardian_"))).toEqual([]);
  });

  it("the opt-in request names only the user", async () => {
    const h = makeHarness();
    await h.text(USER, "hi");
    await h.text(USER, "Alex");
    await h.text(USER, "Priya 919 555 0142");
    await h.text(GUARDIAN, "hey");
    const req = h.sentTo(GUARDIAN)[0]!;
    expect(req.template).toBe("gdn_optin_request");
    for (const d of PLAN_DETAILS) expect(req.text).not.toContain(d);
  });

  it("a plan is never armed without an explicit go after the confirmation", async () => {
    const llm = new FakeLlmProvider((req) => {
      if (req.task !== "extractPlan") throw new Error("x");
      return {
        type: "date",
        startAtText: "at 7",
        startAtISO: "2026-10-17T19:00:00-05:00",
        venueText: "Lula Cafe",
        durationMin: 120,
        counterpartName: "Jordan",
        counterpartSource: "Hinge",
        transport: "walk",
        firstTimeInPerson: true,
        buyOrSell: null,
        meetingAtPrivateAddress: null,
        userNervous: false,
        wantsToChange: [],
        confidence: 0.9,
      };
    });
    const h = makeHarness({ llm });
    await seedUser(h);
    for (const t of ["date with Jordan at 7 at Lula Cafe", "ok cool", "sounds fun", "what do you think", "Jordan from hinge"]) {
      await h.text(USER, t === "ok cool" ? "hmm" : t);
    }
    expect(h.dispatched.filter((d) => d.event.type === "arm")).toEqual([]);
    expect(h.sentTo(USER).some((s) => s.template === "plan_confirm")).toBe(true);
    await h.text(USER, "go");
    expect(h.dispatched.filter((d) => d.event.type === "arm").length).toBe(1);
  });
});
