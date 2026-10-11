// I13. Disclosure at onboarding: automated assistant, not a person, not an emergency service, can
// fail. I15. Adults only: onboarding says 18+; age is never asked or stored.
import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../apps/server/src/notify/templates.js";
import { USER, makeHarness } from "../unit/conversation/helpers.js";

async function onboard() {
  const h = makeHarness();
  await h.text(USER, "hi");
  await h.text(USER, "Alex");
  await h.text(USER, "Priya 919 555 0142");
  await h.text(USER, "exit pineapple alert blue moon");
  return h;
}

describe("I13 disclosure", () => {
  it("the disclosure says automated, not a person, not 911, and that it can fail", () => {
    const t = renderTemplate("onb_disclosure_done");
    expect(t).toContain("automated assistant");
    expect(t).toContain("not a person");
    expect(t).toContain("not 911");
    expect(t).toMatch(/phone is dead/);
    expect(t).toMatch(/no signal/);
    expect(t).toMatch(/can fail/);
  });

  it("is sent during onboarding before the user can plan", async () => {
    const h = await onboard();
    const templates = h.sentTo(USER).map((s) => s.template);
    expect(templates).toContain("onb_disclosure_done");
    const u = (await h.repo.getUserByAddress(USER))!;
    expect(u.onboardingStep).toBe("done");
  });

  it("a user who has not seen the disclosure cannot start a plan", async () => {
    const h = makeHarness();
    await h.text(USER, "hi");
    await h.text(USER, "Alex");
    await h.text(USER, "date tonight at 7 at Lula Cafe");
    const u = (await h.repo.getUserByAddress(USER))!;
    expect(await h.repo.getOpenPlanForUser(u.id)).toBeNull();
    expect(h.dispatched).toEqual([]);
  });

  it("the guardian opt-in also says Batman is automated", () => {
    expect(renderTemplate("gdn_optin_request", { userName: "Alex" })).toContain("an automated assistant");
  });
});

describe("I15 adults only", () => {
  it("onboarding states 18+", async () => {
    const h = await onboard();
    expect(h.sentTo(USER).some((s) => s.text.includes("You must be 18+ to use me."))).toBe(true);
  });

  it("never asks for or stores age", async () => {
    const h = await onboard();
    for (const s of h.sent) expect(s.text).not.toMatch(/how old|your age|birthday|date of birth/i);
    const u = (await h.repo.getUserByAddress(USER))! as unknown as Record<string, unknown>;
    expect(Object.keys(u).some((k) => /age|birth|dob/i.test(k))).toBe(false);
  });
});
