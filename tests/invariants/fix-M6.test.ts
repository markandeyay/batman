// M6 (I10): in a discreet state the check runs on the RENDERED text, not just the template id.
// Values the user typed (a venue like "Police station safe exchange zone") are dropped for a
// value-free variant; if even that is not discreet, nothing is sent.
import { describe, expect, it } from "vitest";
import { isDiscreet } from "../../apps/server/src/notify/discretion.js";
import { renderForUser, renderTemplate } from "../../apps/server/src/notify/templates.js";
import { USER, makeHarness, seedPlan, seedUser } from "../unit/conversation/helpers.js";
import { FakeClock, T0, USER as GW_USER, makeExecutor, seededStore } from "../unit/integration/gatewayHelpers.js";

const VENUE = "Police station safe exchange zone";

describe("M6 discretion on rendered text", () => {
  it("renderForUser drops user-typed values in a discreet state and keeps them outside one", () => {
    expect(renderForUser("act_venue_confirm", { venueText: VENUE }, "ACTIVE")).toBe("Got it, new spot.");
    expect(renderForUser("act_venue_confirm", { venueText: VENUE }, "ARMED")).toBe("Got it, Police station safe exchange zone.");
    expect(renderForUser("act_venue_confirm", { venueText: "Lula Cafe" }, "ACTIVE")).toBe("Got it, Lula Cafe.");
  });

  it("engine sends through the executor: act_venue_confirm with a revealing venue goes out value-free", async () => {
    const { store, plan } = seededStore("ACTIVE");
    const t = makeExecutor(store, new FakeClock(T0), { render: (id, p) => renderTemplate(id, p, { variant: 0 }) });
    await t.executor.send({ kind: "send", to: "user", template: "act_venue_confirm", params: { venueText: VENUE } }, plan);
    const sent = t.resolver.space(GW_USER).sent;
    expect(sent).toEqual(["Got it, new spot."]);
    for (const s of sent) expect(isDiscreet(s)).toBe(true);
  });

  it("dialogue status during a window never shows a revealing venue", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ACTIVE", { venueText: VENUE });
    await h.text(USER, "status");
    const last = h.sentTo(USER).at(-1)!;
    expect(last.template).toBe("status");
    expect(isDiscreet(last.text)).toBe(true);
    expect(last.text).not.toContain("Police");
  });

  it("dialogue status outside a window keeps the venue", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ARMED", { venueText: VENUE });
    await h.text(USER, "status");
    expect(h.sentTo(USER).at(-1)!.text).toContain("Police station");
  });
});
