// L7 (I1): a tapback arms a plan awaiting "go" only when it targets Batman's plan confirmation.
import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../../../apps/server/src/nlu/llm.js";
import { USER, makeHarness, seedUser } from "../conversation/helpers.js";

const extraction = {
  type: "date",
  startAtText: "at 7",
  startAtISO: "2026-10-17T19:00:00-05:00",
  venueText: "Lula Cafe, 2537 N Kedzie",
  durationMin: 120,
  counterpartName: "Jordan",
  counterpartSource: "Hinge",
  transport: "self_drive",
  firstTimeInPerson: true,
  buyOrSell: null,
  meetingAtPrivateAddress: null,
  userNervous: false,
  wantsToChange: [],
  confidence: 0.9,
};

async function toConfirmation() {
  const h = makeHarness({
    llm: new FakeLlmProvider((req) => {
      if (req.task === "extractPlan") return extraction;
      throw new Error("no phrasing in tests");
    }),
  });
  const { user } = await seedUser(h);
  expect(await h.text(USER, "first date w Jordan from hinge at 7, Lula Cafe 2537 N Kedzie, driving, 2 hours")).toBe("intake_confirm");
  const ds = await h.repo.getDialogueState(user.id);
  const pending = ds?.pending;
  expect(pending?.kind).toBe("go");
  const confirmId = pending && pending.kind === "go" ? pending.confirmMessageId : null;
  expect(confirmId).toBeTruthy();
  h.clear();
  return { h, confirmId: confirmId! };
}

describe("L7 tapback arming", () => {
  it("a like on some other message does not arm", async () => {
    const { h, confirmId } = await toConfirmation();
    const other = `${confirmId}-other`;
    expect(await h.inbound(USER, { kind: "reaction", emoji: "like", targetMessageId: other, removed: false })).toBe("reaction_ignored");
    expect(h.dispatched).toEqual([]);
  });

  it("a like on the plan confirmation arms", async () => {
    const { h, confirmId } = await toConfirmation();
    await h.inbound(USER, { kind: "reaction", emoji: "like", targetMessageId: confirmId, removed: false });
    expect(h.dispatched.map((d) => d.event.type)).toEqual(["arm"]);
  });

  it("a dislike on the plan confirmation does not arm", async () => {
    const { h, confirmId } = await toConfirmation();
    await h.inbound(USER, { kind: "reaction", emoji: "dislike", targetMessageId: confirmId, removed: false });
    expect(h.dispatched).toEqual([]);
  });
});
