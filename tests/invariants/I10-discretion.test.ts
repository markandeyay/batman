// I10. Discretion: during DISCREET_STATES every message to the user reads like a text from a
// friend. Scans every template reachable in those states (all variants, several param sets) for
// banned words, and checks the send guard blocks anything else.
import { describe, expect, it } from "vitest";
import { DISCREET_STATES, TEMPLATE_IDS, TRIGGER_IDS } from "../../apps/server/src/contracts.js";
import { sendTemplate, sendText } from "../../apps/server/src/dialogue/out.js";
import { BANNED_PATTERNS, findBannedWords, validateCopy } from "../../apps/server/src/notify/discretion.js";
import { DISCREET_TEMPLATES, GUARDIAN_TEMPLATES, canSendInState, renderAllVariants, type TemplateParams } from "../../apps/server/src/notify/templates.js";
import { EXTRA_COPY } from "../../apps/server/src/notify/templates.js";
import { blankPlan } from "../../apps/server/src/dialogue/memoryRepo.js";
import { USER, makeHarness, seedPlan, seedUser } from "../unit/conversation/helpers.js";

const plan = blankPlan("u", new Date("2026-10-17T20:00:00Z"), {
  type: "date",
  venueText: "Lula Cafe",
  counterpartName: "Jordan",
  counterpartSource: "Hinge",
  startAt: new Date("2026-10-18T00:00:00Z"),
  endAt: new Date("2026-10-18T02:00:00Z"),
});

const PARAM_SETS: TemplateParams[] = [
  {},
  { plan, userName: "Alex", guardianName: "Priya", tz: "America/Chicago", state: "ACTIVE", changes: ["now Sat 8:00 PM"], expiresAt: new Date() },
  { plan: { ...plan, type: "marketplace", buyOrSell: "buy" }, guardianName: null, closed: true, state: "CLOSING" },
  { plan: { ...plan, type: "viewing" }, state: "OVERTIME", soon: true },
  ...TRIGGER_IDS.map((t) => ({ plan: { ...plan, ladderTrigger: t }, trigger: t, state: "CHECKING" as const })),
];

describe("I10 discretion", () => {
  it("the banned list covers the spec words", () => {
    const words = BANNED_PATTERNS.map((b) => b.word);
    for (const w of ["safety", "alert", "emergency", "danger", "batman", "check-in"]) expect(words).toContain(w);
  });

  it("covers every user-facing template that is not onboarding or pre-window only", () => {
    const userFacing = TEMPLATE_IDS.filter((id) => !GUARDIAN_TEMPLATES.includes(id));
    expect(DISCREET_TEMPLATES.length).toBeGreaterThan(40);
    for (const id of ["lad_l0_soft", "lad_l1", "lad_l2_text", "lad_clarify", "ot_overtime", "act_arrival", "cw_exit_reply", "close_glad_back", "status", "plain_checkin_error"] as const) {
      expect(DISCREET_TEMPLATES).toContain(id);
    }
    expect(userFacing.length).toBeGreaterThan(DISCREET_TEMPLATES.length);
  });

  it.each(DISCREET_TEMPLATES.map((id) => [id]))("%s has no banned words in any variant", (id) => {
    for (const p of PARAM_SETS) {
      for (const text of renderAllVariants(id, p)) expect(findBannedWords(text), `${id}: ${text}`).toEqual([]);
    }
  });

  it("extra copy usable in a window is discreet", () => {
    for (const t of [EXTRA_COPY.codewords_busy(), EXTRA_COPY.ask_caller(), EXTRA_COPY.caller_set("mom"), EXTRA_COPY.delete_kept(), EXTRA_COPY.ask_new_guardian(), EXTRA_COPY.replace_kept()]) {
      expect(findBannedWords(t)).toEqual([]);
    }
  });

  it.each(DISCREET_STATES.map((s) => [s]))("the send guard blocks non-discreet templates and text in %s", async (state) => {
    const h = makeHarness();
    expect(canSendInState("onb_ask_codewords", state)).toBe(false);
    expect(canSendInState("help", state)).toBe(false);
    expect(await sendTemplate(h.ports, USER, "onb_ask_codewords", {}, { planState: state })).toBeNull();
    expect(await sendText(h.ports, USER, "Your safety alert is active", { planState: state })).toBeNull();
    expect(await sendTemplate(h.ports, USER, "lad_l1", {}, { planState: state })).not.toBeNull();
    expect(h.sent.map((s) => s.template)).toEqual(["lad_l1"]);
  });

  it("every user message sent by the dialogue in a window is discreet", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    for (const state of DISCREET_STATES) {
      const p = await seedPlan(h, user.id, guardianId, state);
      for (const t of ["status", "change code words", "change caller", "boss", "delete my data", "no", "change backup", "no", "what", "help"]) {
        await h.text(USER, t);
      }
      await h.inbound(USER, { kind: "other" });
      await h.inbound(USER, { kind: "voice_unavailable" });
      h.repo.setPlanState(p.id, "CLOSED");
    }
    const toUser = h.sentTo(USER);
    expect(toUser.length).toBeGreaterThan(10);
    for (const s of toUser) expect(findBannedWords(s.text), s.text).toEqual([]);
  });

  it("LLM copy with banned words is rejected", () => {
    expect(validateCopy("Quick check-in: you okay?", []).ok).toBe(false);
  });
});
