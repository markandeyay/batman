import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../../../apps/server/src/nlu/llm.js";
import { formatDayTime } from "../../../apps/server/src/geo/timezone.js";
import { GUARDIAN, TZ, USER, makeHarness, seedPlan, seedUser } from "./helpers.js";

const base = {
  type: null,
  startAtText: null,
  startAtISO: null,
  venueText: null,
  durationMin: null,
  counterpartName: null,
  counterpartSource: null,
  transport: null,
  firstTimeInPerson: null,
  buyOrSell: null,
  meetingAtPrivateAddress: null,
  userNervous: false,
  wantsToChange: [],
  confidence: 0.9,
};

/** Fake LLM that answers per task. */
function llmWith(extract: (user: string) => Record<string, unknown>, classify?: (user: string) => Record<string, unknown>) {
  return new FakeLlmProvider((req) => {
    if (req.task === "extractPlan") return { ...base, ...extract(req.user) };
    if (req.task === "classifyReply") return classify ? classify(req.user) : { label: "OK", command: null, extendMin: null, confidence: 0.95 };
    throw new Error("no phrasing in tests"); // copy falls back to the bank
  });
}

describe("intake (4.4)", () => {
  it("complete first message -> confirmation -> GO -> tapback + arm", async () => {
    const h = makeHarness({
      llm: llmWith(() => ({
        type: "date",
        startAtText: "at 7",
        startAtISO: "2026-10-17T19:00:00-05:00",
        venueText: "Lula Cafe, 2537 N Kedzie",
        counterpartName: "Jordan",
        counterpartSource: "Hinge",
        transport: "self_drive",
        firstTimeInPerson: true,
        durationMin: 120,
      })),
    });
    const { user } = await seedUser(h);
    expect(await h.text(USER, "first date w Jordan from hinge at 7, Lula Cafe 2537 N Kedzie, driving, 2 hours")).toBe("intake_confirm");
    const confirm = h.sentTo(USER).at(-1)!;
    expect(confirm.template).toBe("plan_confirm");
    expect(confirm.text).toContain("Date with Jordan (Hinge), Sat 7:00 PM at Lula Cafe, 2537 N Kedzie");
    expect(confirm.text).toContain("Back by about 9:00 PM. You're driving yourself.");
    expect(h.dispatched).toEqual([]);
    expect(await h.text(USER, "go")).toBe("intake_armed");
    expect(h.reactions.length).toBe(1);
    const plan = (await h.repo.getOpenPlanForUser(user.id))!;
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "arm", guardianAccepted: true } }]);
    expect(plan).toMatchObject({ state: "ARMED", graceMin: 15, venueLat: 41.9172 });
  });

  it("asks at most 3 questions in one message, required first, then states the default", async () => {
    const h = makeHarness({ llm: llmWith(() => ({ type: "date", counterpartName: "Jordan" })) });
    await seedUser(h);
    expect(await h.text(USER, "got a date with Jordan later")).toBe("intake_questions");
    const q = h.sentTo(USER).at(-1)!;
    expect(q.template).toBe("intake_questions"); // routed through a fixed template (9.4)
    expect(q.text.startsWith("What time are you meeting? Where are you meeting?")).toBe(true);
    expect(q.text).toContain("I'll assume about 2 hours, tell me if it's longer.");
    expect((q.text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it("asks again only for missing required fields, then confirms with defaults", async () => {
    let call = 0;
    const h = makeHarness({
      llm: llmWith(() => {
        call++;
        if (call === 1) return { type: "marketplace", buyOrSell: "sell" };
        if (call === 2) return { startAtText: "5pm", startAtISO: "2026-10-17T17:00:00-05:00" };
        return { venueText: "Target parking lot" };
      }),
    });
    await seedUser(h);
    await h.text(USER, "selling my couch on marketplace");
    await h.text(USER, "5pm");
    const second = h.sentTo(USER).at(-1)!;
    expect(second.text).toBe("Where are you meeting?");
    expect(await h.text(USER, "Target parking lot")).toBe("intake_confirm");
    const c = h.sentTo(USER).at(-1)!;
    expect(c.text).toContain("Marketplace sale, Sat 5:00 PM at Target parking lot");
    expect(c.text).toContain("I'm assuming about 20 min");
  });

  it("asks to confirm a disputed time and never arms on it unconfirmed", async () => {
    const h = makeHarness({ llm: llmWith(() => ({ type: "date", startAtText: "at 7", startAtISO: "2026-10-17T07:00:00-05:00", venueText: "Lula Cafe" })) });
    await seedUser(h);
    expect(await h.text(USER, "date at 7 at lula cafe")).toBe("intake_time_confirm");
    const ask = h.sentTo(USER).at(-1)!;
    expect(ask.template).toBe("plan_time_confirm_ask");
    expect(ask.text).toBe("Just to be sure, is that Sat 7:00 PM?");
    await h.text(USER, "yes");
    expect(h.sentTo(USER).some((s) => s.template === "plan_confirm" || s.template === "intake_questions")).toBe(true);
    expect(h.dispatched).toEqual([]);
  });

  it("past time asks 'did you mean' with the next day", async () => {
    const h = makeHarness({ llm: llmWith(() => ({ type: "viewing", startAtText: "at 9am today", venueText: "12 Elm St" })) });
    await seedUser(h);
    expect(await h.text(USER, "viewing at 9am today at 12 Elm St")).toBe("intake_time_past");
    expect(h.sentTo(USER).at(-1)!.text).toBe("That time already passed. Did you mean Sun 9:00 AM?");
  });

  it("second plan while one is armed asks to replace (one active plan)", async () => {
    const h = makeHarness({
      llm: llmWith(() => ({ type: "marketplace", startAtText: "tomorrow at 3pm", startAtISO: "2026-10-18T15:00:00-05:00", venueText: "Walmart on Cicero" })),
    });
    const { user, guardianId } = await seedUser(h);
    const old = await seedPlan(h, user.id, guardianId, "ARMED");
    expect(await h.text(USER, "also picking up a bike tomorrow at 3pm at Walmart on Cicero")).toBe("intake_replace_ask");
    expect(h.sentTo(USER).at(-1)!.template).toBe("plan_replace_ask");
    await h.text(USER, "yes");
    expect(h.dispatched[0]).toEqual({ planId: old.id, event: { type: "user_command", command: "cancel" } });
    const now = (await h.repo.getOpenPlanForUser(user.id))!;
    expect(now.id).not.toBe(old.id);
    expect(now.type).toBe("marketplace");
  });

  it("edit after arming re-confirms only the change and tells the engine", async () => {
    const h = makeHarness({ llm: llmWith(() => ({ startAtText: "8pm", startAtISO: "2026-10-17T20:00:00-05:00", wantsToChange: ["startAt"] })) });
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ARMED");
    expect(await h.text(USER, "actually 8pm")).toBe("intake_edit");
    expect(h.sentTo(USER).at(-1)!.text).toBe("Got it, now Sat 8:00 PM.");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "plan_edited", fields: ["startAt", "endAt"] } }]);
    const p = (await h.repo.getPlan(plan.id))!;
    expect(formatDayTime(p.endAt!, TZ)).toBe("Sat 10:00 PM");
  });

  it("GO with a pending guardian goes to AWAITING_GUARDIAN", async () => {
    const h = makeHarness({ llm: llmWith(() => ({ type: "other", startAtText: "at 6pm", startAtISO: "2026-10-17T18:00:00-05:00", venueText: "Lula Cafe", durationMin: 60, counterpartName: "Sam", transport: "walk" })) });
    await seedUser(h, { guardian: "pending" });
    await h.text(USER, "meeting Sam at 6pm at Lula Cafe for an hour, walking");
    expect(await h.text(USER, "go")).toBe("intake_awaiting_guardian");
    expect(h.dispatched.at(-1)!.event).toEqual({ type: "arm", guardianAccepted: false });
  });

  it("unsupported content (a pin without coordinates) during venue intake asks for a link or address", async () => {
    const h = makeHarness({ llm: llmWith(() => ({ type: "date", startAtText: "at 7", startAtISO: "2026-10-17T19:00:00-05:00" })) });
    await seedUser(h);
    await h.text(USER, "date at 7");
    expect(await h.inbound(USER, { kind: "other" })).toBe("pin_unsupported");
    expect(h.sentTo(USER).at(-1)!.text).toBe("Can you send that as a Maps link or just type the address?");
  });

  it("unsupported content outside intake gets the generic reply", async () => {
    const h = makeHarness();
    await seedUser(h);
    expect(await h.inbound(USER, { kind: "other" })).toBe("unsupported");
  });

  it("works with no LLM at all (deterministic fallback)", async () => {
    const h = makeHarness({ llm: null });
    await seedUser(h);
    await h.text(USER, "First date with Jordan from Hinge tonight at 7 at Lula Cafe, I'll drive");
    expect(h.sentTo(USER).length).toBeGreaterThan(0);
    expect((await h.repo.getOpenPlanForUser((await h.repo.getUserByAddress(USER))!.id))?.type).toBe("date");
  });
});

describe("manager routing (8.4)", () => {
  it("code words in a window dispatch deterministically, with no LLM call (I8)", async () => {
    const llm = llmWith(() => ({}));
    const h = makeHarness({ llm });
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ACTIVE");
    expect(await h.text(USER, "omg PINEAPPLE")).toBe("codeword_exit");
    expect(await h.text(USER, "blue moon pineapple")).toBe("codeword_alert");
    expect(h.dispatched.map((d) => d.event.type)).toEqual(["exit_word", "alert_word"]);
    expect(h.dispatched[0]!.planId).toBe(plan.id);
    expect(llm.calls.length).toBe(0);
    expect(h.sent).toEqual([]); // the engine sends the innocuous reply (I9)
  });

  it("code words outside a window do nothing special", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ARMED");
    expect(await h.text(USER, "pineapple")).not.toMatch(/^codeword/);
  });

  it("voice transcripts get the phonetic pass", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "CHECKING");
    expect(await h.text(USER, "uh blew moon", { fromVoice: true })).toBe("codeword_alert");
  });

  it("voice_unavailable replies and counts as AMBIGUOUS during CHECKING", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "CHECKING");
    await h.inbound(USER, { kind: "voice_unavailable" });
    expect(h.sentTo(USER)[0]!.template).toBe("voice_unavailable");
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "user_reply", label: "AMBIGUOUS", messageId: expect.any(String) } }]);
  });

  it("help in a window is distress; outside it is the help text", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ACTIVE");
    expect(await h.text(USER, "help")).toBe("distress");
    expect(h.dispatched[0]!.event.type).toBe("distress");
    h.repo.setPlanState(plan.id, "CLOSED");
    expect(await h.text(USER, "help")).toBe("help");
  });

  it.each([
    ["+30", { type: "user_command", command: "extend", minutes: 30 }],
    ["done", { type: "user_command", command: "done" }],
    ["made it home", { type: "user_command", command: "home" }],
    ["cancel", { type: "user_command", command: "cancel" }],
  ])("window command %s", async (text, event) => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "OVERTIME");
    await h.text(USER, text);
    expect(h.dispatched[0]!.event).toEqual(event);
  });

  it("moving is geocoded near the venue", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ACTIVE");
    await h.text(USER, "we're moving to Lula Cafe");
    expect(h.dispatched[0]!.event).toMatchObject({ type: "user_command", command: "moving", venueText: "Lula Cafe", venueLat: 41.9172 });
  });

  it("classifier labels go to the engine as user_reply", async () => {
    const h = makeHarness({ llm: llmWith(() => ({}), () => ({ label: "OK", command: null, extendMin: null, confidence: 0.97 })) });
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "CHECKING");
    expect(await h.text(USER, "yeah lol all gud")).toBe("reply_ok");
  });

  it("LLM down during CHECKING still resolves 'im good' (S-22)", async () => {
    const down = new FakeLlmProvider(() => {
      throw new Error("down");
    });
    const h = makeHarness({ llm: down });
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "CHECKING");
    expect(await h.text(USER, "im good")).toBe("reply_ok");
    expect(h.dispatched[0]!.event).toMatchObject({ type: "user_reply", label: "OK" });
  });

  it("reactions in a window go to the engine", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "CHECKING");
    await h.inbound(USER, { kind: "reaction", emoji: "like", targetMessageId: "out_9", removed: false });
    expect(h.dispatched[0]!.event).toEqual({ type: "user_reaction", emoji: "like", targetMessageId: "out_9" });
  });

  it("change code words is deferred during a window (I10)", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ACTIVE");
    expect(await h.text(USER, "change code words")).toBe("codewords_busy");
  });

  it("change code words and caller outside a window", async () => {
    const h = makeHarness();
    const { user } = await seedUser(h);
    await h.text(USER, "change code words");
    await h.text(USER, "exit marmalade alert purple rain");
    expect(await h.repo.getCodeWords(user.id)).toEqual({ exit: "marmalade", alert: "purple rain" });
    await h.text(USER, "change caller");
    await h.text(USER, "mom");
    expect((await h.repo.getUser(user.id))!.decoyCaller).toBe("mom");
  });

  it("delete my data asks first, then deletes and texts the guardian nothing", async () => {
    const h = makeHarness();
    const { user } = await seedUser(h);
    await h.text(USER, "delete my data");
    expect(h.sentTo(USER).at(-1)!.template).toBe("delete_confirm_ask");
    await h.text(USER, "yes");
    expect(h.sentTo(USER).at(-1)!.template).toBe("delete_done");
    expect(await h.repo.getUser(user.id)).toBeNull();
    expect(h.sentTo(GUARDIAN)).toEqual([]);
  });

  it("status shows the plan", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ARMED");
    await h.text(USER, "status");
    expect(h.sentTo(USER)[0]!.text).toBe("Date with Jordan (Hinge), Sat 7:00 PM at Lula Cafe, 2537 N Kedzie, back by about 9:00 PM.\nLocked in.");
  });
});
