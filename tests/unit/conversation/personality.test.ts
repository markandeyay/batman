// Personality (spec 4.1, 9.4): outside DISCREET_STATES, an off-script message gets one short
// validated in-character line that acknowledges it, then one line steering back to the step.
// Fast model, effort low, 6 s budget, template fallback, typing indicator around every call.
// Never in DISCREET_STATES, never during code word entry (I8), never in safety-critical copy.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { FakeLlmProvider, type LlmRequest } from "../../../apps/server/src/nlu/llm.js";
import { phraseQuestions, questionItem } from "../../../apps/server/src/notify/copy.js";
import { chatTopic, smallTalkReply, validateSmallTalk } from "../../../apps/server/src/notify/smalltalk.js";
import { GUARDIAN, USER, makeHarness, seedPlan, seedUser, type Harness } from "./helpers.js";

type Req = LlmRequest<z.ZodType>;

const nothing = {
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

/** LLM fake: extraction finds nothing; small talk answers with `line`; records requests. */
function chatty(line: string | ((req: Req) => string), extract: (last: string) => Record<string, unknown> = () => ({})) {
  const reqs: Req[] = [];
  const llm = new FakeLlmProvider((req) => {
    reqs.push(req);
    if (req.task === "smallTalk") return { text: typeof line === "string" ? line : line(req) };
    if (req.task === "extractPlan") {
      const msgs = (JSON.parse(req.user) as { messages: string[] }).messages;
      return { ...nothing, ...extract(msgs[msgs.length - 1]!.toLowerCase()) };
    }
    if (req.task === "classifyReply") return { label: "AMBIGUOUS", command: null, extendMin: null, confidence: 0.5 };
    throw new Error(`no ${req.task}`);
  });
  return { llm, reqs };
}

/** Wrap ports.typing so tests can see that every model call runs inside the typing indicator. */
function trackTyping(h: Harness): { depth: () => number; count: () => number } {
  let depth = 0;
  let count = 0;
  const inner = h.ports.typing.bind(h.ports);
  h.ports.typing = async (to, fn) => {
    depth++;
    count++;
    try {
      return await inner(to, fn);
    } finally {
      depth--;
    }
  };
  return { depth: () => depth, count: () => count };
}

describe("chatTopic", () => {
  it.each([
    ["who are you?", "who"],
    ["are you a bot", "who"],
    ["what can you do", "what"],
    ["wait who's gonna get texted?", "who_texted"],
    ["thanks!", "thanks"],
    ["hey", "greeting"],
    ["lol", "laugh"],
    ["this is so annoying", "complaint"],
    ["why do you need that?", "question"],
    ["Will", null],
    ["Marky", null],
    ["Priya 919 555 0142", null],
  ])("%s -> %s", (t, topic) => {
    expect(chatTopic(t)).toBe(topic);
  });
});

describe("validated small talk copy (9.4)", () => {
  const facts = ["Madhu", "who are you?"];
  it.each([
    ["Gotham's finest, at your service.", "comics"],
    ["Stay safe out there!", "banned:safe"],
    ["I'm Batman.", "banned:batman"],
    ["Two emoji 🦇🌙 is too many.", "too_many_emoji"],
    ["I'll text Jordan for you.", "ungrounded_name:Jordan"],
    ["x".repeat(201), "too_long"],
    ["**bold** move", "markdown"],
  ])("rejects %s", (text, reason) => {
    expect(validateSmallTalk(text, facts)).toContain(reason);
  });

  it("uses the fast model, effort low, 6 s, and falls back to null on failure", async () => {
    const { llm, reqs } = chatty("Night owl, mostly. I look out for you when you meet someone new.");
    const r = await smallTalkReply({ message: "who are you?", step: "idle", facts: {} }, llm);
    expect(r?.text).toBe("Night owl, mostly. I look out for you when you meet someone new.");
    expect(reqs[0]).toMatchObject({ task: "smallTalk", tier: "fast", effort: "low", timeoutMs: 6000 });
    const down = new FakeLlmProvider(() => {
      throw new Error("down");
    });
    expect(await smallTalkReply({ message: "who are you?", step: "idle", facts: {} }, down)).toBeNull();
  });

  it("intake question phrasing uses the same fast, low effort, 6 s budget", async () => {
    const { llm, reqs } = chatty("x");
    await phraseQuestions([questionItem("start_time")], { userName: "Marky" }, new FakeLlmProvider((req) => {
      reqs.push(req);
      return { text: "What time are you meeting?" };
    }));
    void llm;
    expect(reqs[0]).toMatchObject({ task: "phraseQuestions", tier: "fast", effort: "low", timeoutMs: 6000 });
  });
});

describe("onboarding off-script", () => {
  it("ask_name: 'who are you?' is answered in character, then steered back; not taken as a name", async () => {
    const { llm, reqs } = chatty("I'm the friend who quietly looks out for you when you meet someone new.");
    const h = makeHarness({ llm });
    const typing = trackTyping(h);
    await h.text(USER, "hi");
    h.clear();
    expect(await h.text(USER, "who are you?")).toBe("onboarding_smalltalk");
    expect(h.sentTo(USER).map((s) => s.text)).toEqual([
      "I'm the friend who quietly looks out for you when you meet someone new.",
      "Anyway, what should I call you?",
    ]);
    const u = (await h.repo.getUserByAddress(USER))!;
    expect(u.displayName).toBeNull();
    expect(u.onboardingStep).toBe("ask_name");
    expect(reqs.map((r) => r.task)).toEqual(["smallTalk"]);
    expect(typing.count()).toBeGreaterThan(0);
    expect(await h.text(USER, "Marky")).toBe("onboarding_name");
  });

  it("ask_name: a bare greeting is not a name", async () => {
    const h = makeHarness({ llm: chatty("Hey there.").llm });
    await h.text(USER, "hi");
    expect(await h.text(USER, "hey")).toBe("onboarding_smalltalk");
    expect((await h.repo.getUserByAddress(USER))!.displayName).toBeNull();
  });

  it("ask_guardian: a question gets an answer and the backup ask again, not 'no number'", async () => {
    const h = makeHarness({ llm: chatty("Fair question. Your backup only hears from me if you might need help.").llm });
    await h.text(USER, "hi");
    await h.text(USER, "Marky");
    h.clear();
    expect(await h.text(USER, "why do you need that?")).toBe("onboarding_smalltalk");
    expect(h.sentTo(USER).map((s) => s.template)).toEqual([null, "smalltalk_steer"]);
    expect(h.sentTo(USER)[1]!.text).toContain("who should be your backup?");
    expect(await h.inbound(USER, { kind: "contact", name: "Madhu", phones: [GUARDIAN] })).toBe("onboarding_guardian");
  });

  it("ask_codewords: never calls the model, even for a question (I8)", async () => {
    const { llm, reqs } = chatty("should never be used");
    const h = makeHarness({ llm });
    await h.text(USER, "hi");
    await h.text(USER, "Marky");
    await h.inbound(USER, { kind: "contact", name: "Madhu", phones: [GUARDIAN] });
    reqs.length = 0;
    await h.text(USER, "what's a code word?");
    await h.text(USER, "pineapple");
    expect(reqs).toEqual([]);
  });
});

describe("idle small talk (item 6)", () => {
  it("answers in character plus a hint of what Batman does; no plan is created", async () => {
    const h = makeHarness({ llm: chatty("Mostly I keep night owl hours and look out for you when you meet someone new.").llm });
    const { user } = await seedUser(h, { name: "Marky" });
    expect(await h.text(USER, "what's up")).toBe("idle_smalltalk");
    expect(h.sentTo(USER).map((s) => s.text)).toEqual([
      "Mostly I keep night owl hours and look out for you when you meet someone new.",
      "Whenever you're meeting someone new, text me who, where, and when.",
    ]);
    expect(await h.repo.getOpenPlanForUser(user.id)).toBeNull();
  });

  it("with the model down, a known question gets the fixed answer plus the hint", async () => {
    const h = makeHarness({ llm: new FakeLlmProvider(() => Promise.reject(new Error("down"))) });
    await seedUser(h);
    expect(await h.text(USER, "what can you do?")).toBe("idle_smalltalk");
    const out = h.sentTo(USER);
    expect(out.map((s) => s.template)).toEqual(["smalltalk_reply", "smalltalk_steer"]);
    expect(out[0]!.text).toContain("who, where, and when");
  });

  it("a rejected model line falls back to the template", async () => {
    const h = makeHarness({ llm: chatty("I'm Batman, protector of Gotham.").llm });
    await seedUser(h);
    await h.text(USER, "who are you?");
    expect(h.sentTo(USER)[0]!.template).toBe("smalltalk_reply");
    expect(h.sentTo(USER)[0]!.text).not.toMatch(/gotham/i);
  });
});

describe("intake and armed off-script", () => {
  it("while answering follow-up questions: answer, then re-ask what is still missing", async () => {
    const { llm } = chatty("Ha, fair. It helps me know when to look out for you.", (last) =>
      last.includes("jordan") ? { type: "date", counterpartName: "Jordan" } : {},
    );
    const h = makeHarness({ llm });
    await seedUser(h, { name: "Marky" });
    await h.text(USER, "got a date with jordan later");
    h.clear();
    expect(await h.text(USER, "lol why do you need to know?")).toBe("intake_smalltalk");
    const out = h.sentTo(USER);
    expect(out[0]!.text).toBe("Ha, fair. It helps me know when to look out for you.");
    expect(out[1]!.template).toBe("smalltalk_steer");
    expect(out[1]!.text).toBe("What time are you meeting? Where are you meeting?");
  });

  it("armed: a question gets an answer and a one-line status, not the plan summary", async () => {
    const h = makeHarness({ llm: chatty("Not a person, just a very attentive night owl.").llm });
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ARMED");
    expect(await h.text(USER, "are you a bot?")).toBe("armed_smalltalk");
    expect(h.sentTo(USER).map((s) => s.text)).toEqual([
      "Not a person, just a very attentive night owl.",
      "You're locked in for Sat 7:00 PM. Text me if anything changes.",
    ]);
  });

  it("never in DISCREET_STATES: an ACTIVE question goes to the classifier, no small talk (I10)", async () => {
    const { llm, reqs } = chatty("should never be used");
    const h = makeHarness({ llm });
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ACTIVE");
    await h.text(USER, "who are you?");
    expect(reqs.map((r) => r.task)).not.toContain("smallTalk");
    expect(h.sentTo(USER).some((s) => s.template === "smalltalk_reply" || s.template === "smalltalk_steer")).toBe(false);
  });

  it("every model call runs inside the typing indicator", async () => {
    let depthAtCall = -1;
    const h = makeHarness();
    const typing = trackTyping(h);
    h.ports.llm = new FakeLlmProvider((req) => {
      depthAtCall = typing.depth();
      if (req.task === "smallTalk") return { text: "Hey." };
      return nothing;
    });
    await seedUser(h);
    await h.text(USER, "hey there");
    expect(depthAtCall).toBe(1);
  });
});
