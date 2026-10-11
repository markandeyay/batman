// Live bug (2026-10-10): at the plan confirmation the user tried to change the time twice and got
// the identical plan_confirm back each time. Spec 4.4.6 "re-confirm only changed fields", 9.2
// (chrono first, model disagreement > 15 min asks), 4.1 (short, never lecture).
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, type LlmRequest } from "../../../apps/server/src/nlu/llm.js";
import { formatDayTime } from "../../../apps/server/src/geo/timezone.js";
import type { z } from "zod";
import { TZ, USER, makeHarness, seedPlan, seedUser, type Harness } from "./helpers.js";

/** Sat 2026-10-17 10:54 PM in Chicago (CDT, UTC-5). */
const LATE = new Date("2026-10-18T03:54:00Z");

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

type Handler = (req: LlmRequest<z.ZodType>) => unknown;

function llm(extra: { extract?: (last: string) => Record<string, unknown> | null; smallTalk?: Handler } = {}) {
  return new FakeLlmProvider((req) => {
    if (req.task === "extractPlan") {
      const msgs = (JSON.parse(req.user) as { messages: string[] }).messages;
      const last = msgs[msgs.length - 1]!.toLowerCase();
      if (last.includes("cookout")) return { ...base, type: "other", startAtText: "now", venueText: "cookout", counterpartName: "Jordan" };
      const e = extra.extract?.(last);
      if (e) return { ...base, ...e };
      return base;
    }
    if (req.task === "smallTalk" && extra.smallTalk) return extra.smallTalk(req);
    throw new Error(`no ${req.task} in this test`);
  });
}

/** Onboarded Marky (backup Madhu), plan "going to cookout with jordan now" at the confirm step. */
async function atConfirm(l = llm(), guardian: "accepted" | "pending" = "pending"): Promise<Harness> {
  const h = makeHarness({ llm: l });
  h.clock.t = new Date(LATE);
  const { guardianId } = await seedUser(h, { name: "Marky", guardian });
  await h.repo.updateGuardian(guardianId!, { displayName: "Madhu" });
  expect(await h.text(USER, "going to cookout with jordan now")).toBe("intake_confirm");
  expect(h.sentTo(USER).at(-1)!.template).toBe("plan_confirm");
  h.clear();
  return h;
}

const confirms = (h: Harness) => h.sentTo(USER).filter((s) => s.template === "plan_confirm");

describe("confirm step: time edits re-confirm only the time (4.4.6)", () => {
  it("a plan starting now goes straight to the confirmation (no optional questions)", async () => {
    const h = makeHarness({ llm: llm() });
    h.clock.t = new Date(LATE);
    await seedUser(h, { name: "Marky" });
    expect(await h.text(USER, "going to cookout with jordan now")).toBe("intake_confirm");
    expect(h.sentTo(USER).map((s) => s.template)).toEqual(["plan_confirm"]);
  });

  it.each([
    ["actually 11:30", "Sat 11:30 PM"],
    ["make it 11:30pm", "Sat 11:30 PM"],
    ["change the time to 11", "Sat 11:00 PM"],
    ["it's at midnight", "Sun 12:00 AM"],
    ["no it's tomorrow at 7", "Sun 7:00 PM"],
    ["push it 30 min", "Sat 11:24 PM"],
    ["an hour from now", "Sat 11:54 PM"],
    ["starts at 11 not now", "Sat 11:00 PM"],
  ])("%s -> Updated: %s", async (text, when) => {
    const h = await atConfirm();
    expect(await h.text(USER, text)).toBe("intake_updated");
    const out = h.sentTo(USER);
    expect(out.map((s) => s.text)).toEqual([`Updated: ${when}. Reply GO to lock it in.`]);
    expect(confirms(h)).toEqual([]);
    const plan = (await h.repo.getOpenPlanForUser((await h.repo.getUserByAddress(USER))!.id))!;
    expect(formatDayTime(plan.startAt!, TZ)).toBe(when);
    // Duration is kept: the default 1 hour for "other".
    expect(plan.endAt!.getTime() - plan.startAt!.getTime()).toBe(60 * 60_000);
    expect(h.dispatched).toEqual([]); // never arms on an edit (I1)
  });

  it("a duration edit re-confirms only the duration", async () => {
    const h = await atConfirm();
    expect(await h.text(USER, "actually make it 2 hours")).toBe("intake_updated");
    expect(h.sentTo(USER).map((s) => s.text)).toEqual(["Updated: about 2 hours, back by about 12:54 AM. Reply GO to lock it in."]);
    const plan = (await h.repo.getOpenPlanForUser((await h.repo.getUserByAddress(USER))!.id))!;
    expect(formatDayTime(plan.startAt!, TZ)).toBe("Sat 10:54 PM");
    expect(plan.endAt!.getTime() - plan.startAt!.getTime()).toBe(120 * 60_000);
  });

  it("an ambiguous time asks one question, then updates", async () => {
    const h = await atConfirm();
    expect(await h.text(USER, "change it to 2")).toBe("intake_time_choice");
    expect(h.sentTo(USER).at(-1)!.text).toBe("Just to be sure, Sun 2:00 AM or Sun 2:00 PM?");
    expect(await h.text(USER, "pm")).toBe("intake_updated");
    expect(h.sentTo(USER).at(-1)!.text).toBe("Updated: Sun 2:00 PM. Reply GO to lock it in.");
    expect(confirms(h)).toEqual([]);
  });

  it("chrono finds nothing: the model's time alone is confirmed first (9.2), then updated", async () => {
    const h = await atConfirm(
      llm({ extract: (last) => (last.includes("dinner") ? { startAtText: "around dinner tomorrow", startAtISO: "2026-10-18T18:00:00-05:00", wantsToChange: ["startAt"] } : null) }),
    );
    expect(await h.text(USER, "make it around dinner tomorrow")).toBe("intake_edit_time_confirm");
    expect(h.sentTo(USER).at(-1)!.text).toBe("Just to be sure, is that Sun 6:00 PM?");
    expect(await h.text(USER, "yes")).toBe("intake_updated");
    expect(h.sentTo(USER).at(-1)!.text).toBe("Updated: Sun 6:00 PM. Reply GO to lock it in.");
    expect(confirms(h)).toEqual([]);
  });

  it("a venue edit through the extractor re-confirms only the venue", async () => {
    const h = await atConfirm(llm({ extract: (last) => (last.includes("logan") ? { venueText: "Logan Bar", wantsToChange: ["venueText"] } : null) }));
    expect(await h.text(USER, "actually we're going to Logan Bar instead")).toBe("intake_updated");
    expect(h.sentTo(USER).map((s) => s.text)).toEqual(["Updated: at Logan Bar. Reply GO to lock it in."]);
  });

  it("a time plus other details: chrono's time wins, the extractor supplies the rest", async () => {
    const h = await atConfirm(
      llm({ extract: (last) => (last.includes("logan") ? { venueText: "Logan Bar", startAtText: "at 8", startAtISO: "2026-10-18T08:00:00-05:00" } : null) }),
    );
    expect(await h.text(USER, "actually we're meeting at Logan Bar at 11:30")).toBe("intake_updated");
    expect(h.sentTo(USER).map((s) => s.text)).toEqual(["Updated: Sat 11:30 PM, at Logan Bar. Reply GO to lock it in."]);
  });

  it("GO after edits arms; a tapback on the update arms too (I1)", async () => {
    const h = await atConfirm(llm(), "accepted");
    await h.text(USER, "actually 11:30");
    expect(await h.text(USER, "go")).toBe("intake_armed");
    expect(h.dispatched.at(-1)!.event).toEqual({ type: "arm", guardianAccepted: true });

    const h2 = await atConfirm(llm(), "accepted");
    await h2.text(USER, "actually 11:30");
    const u = (await h2.repo.getUserByAddress(USER))!;
    const ds = (await h2.repo.getDialogueState(u.id))!;
    const ref = ds.pending?.kind === "go" ? ds.pending.confirmMessageId! : "missing";
    expect(ref).toBe(ds.lastConfirmMessageId); // the update, not the original summary
    expect(await h2.inbound(USER, { kind: "reaction", emoji: "like", targetMessageId: ref, removed: false })).toBe("intake_armed");
  });
});

describe("confirm step: questions, chatter, and nothing new (4.1, 4.4.6)", () => {
  it("a question gets a brief in-character answer, then the one-line nudge, never the summary", async () => {
    const st = (req: LlmRequest<z.ZodType>) => {
      const u = JSON.parse(req.user) as { message: string; facts: { guardianName: string | null } };
      expect(u.message).toBe("wait who's gonna get texted?");
      return { text: `Only ${u.facts.guardianName}, and only if something seems off and you don't answer me.` };
    };
    const h = await atConfirm(llm({ smallTalk: st }));
    expect(await h.text(USER, "wait who's gonna get texted?")).toBe("intake_confirm_answer");
    expect(h.sentTo(USER).map((s) => s.text)).toEqual([
      "Only Madhu, and only if something seems off and you don't answer me.",
      "Reply GO when you're ready, or tell me what to change.",
    ]);
    expect(confirms(h)).toEqual([]);
  });

  it("with the model down, a known question gets the fixed answer plus the nudge", async () => {
    const h = await atConfirm(llm());
    expect(await h.text(USER, "wait who's gonna get texted?")).toBe("intake_confirm_answer");
    const out = h.sentTo(USER);
    expect(out[0]!.template).toBe("smalltalk_reply");
    expect(out[0]!.text).toContain("Madhu");
    expect(out[1]!.text).toBe("Reply GO when you're ready, or tell me what to change.");
    expect(confirms(h)).toEqual([]);
  });

  it("nothing changed and not a question: only the short nudge", async () => {
    const h = await atConfirm();
    expect(await h.text(USER, "hmm")).toBe("intake_confirm_nudge");
    expect(h.sentTo(USER).map((s) => s.text)).toEqual(["Reply GO when you're ready, or tell me what to change."]);
  });

  it("repeating the same time is not an edit: only the nudge", async () => {
    const h = await atConfirm();
    await h.text(USER, "actually 11:30");
    h.clear();
    expect(await h.text(USER, "make it 11:30pm")).toBe("intake_confirm_nudge");
    expect(h.sentTo(USER).map((s) => s.text)).toEqual(["Reply GO when you're ready, or tell me what to change."]);
  });

  it("never sends the same plan_confirm twice in a row across a messy exchange", async () => {
    const h = await atConfirm();
    for (const t of ["hmm", "actually 11:30", "change the time to 11", "wait", "push it 30 min", "ok?"]) await h.text(USER, t);
    expect(confirms(h)).toEqual([]);
  });

  it("cancel at the confirm step cancels", async () => {
    const h = await atConfirm();
    expect(await h.text(USER, "cancel")).toBe("cmd_cancel");
  });
});

describe("time edits after arming (4.4.6)", () => {
  it.each([
    ["actually 8:30", "Got it, now Sat 8:30 PM."],
    ["push it 30 min", "Got it, now Sat 7:30 PM."],
    ["make it 9pm", "Got it, now Sat 9:00 PM."],
    ["no it's tomorrow at 7", "Got it, now Sun 7:00 PM."],
  ])("%s", async (text, reply) => {
    const h = makeHarness({ llm: llm() });
    const { user, guardianId } = await seedUser(h);
    const plan = await seedPlan(h, user.id, guardianId, "ARMED");
    expect(await h.text(USER, text)).toBe("intake_edit");
    expect(h.sentTo(USER).at(-1)!.text).toBe(reply);
    expect(h.dispatched).toEqual([{ planId: plan.id, event: { type: "plan_edited", fields: ["startAt", "endAt"] } }]);
  });

  it("an ambiguous time after arming asks one question", async () => {
    const h = makeHarness({ llm: llm() });
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ARMED");
    expect(await h.text(USER, "change it to 2")).toBe("intake_time_choice");
    expect(h.sentTo(USER).at(-1)!.text).toBe("Just to be sure, Sun 2:00 AM or Sun 2:00 PM?");
    expect(await h.text(USER, "2pm")).toBe("intake_edit");
    expect(h.sentTo(USER).at(-1)!.text).toBe("Got it, now Sun 2:00 PM.");
  });
});
