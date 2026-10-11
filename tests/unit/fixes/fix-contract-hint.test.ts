// Contract change: InboundContent "other" carries a hint so the dialogue can answer precisely
// (a native location pin, an unsupported attachment, a failed voice note).
import { describe, expect, it } from "vitest";
import { normalizeInbound } from "../../../apps/server/src/gateway/normalize.js";
import { USER, makeHarness, seedPlan, seedUser } from "../conversation/helpers.js";

const base = (content: Record<string, unknown>) =>
  ({ id: "m1", platform: "imessage", direction: "inbound", sender: { id: USER, address: USER }, timestamp: new Date(), content }) as never;

describe("InboundContent other hint", () => {
  it("normalize sets the hint", async () => {
    const pin = await normalizeInbound(base({ type: "custom", raw: { imessage_type: "unsupported-message" } }), { speech: false });
    expect(pin?.message.content).toEqual({ kind: "other", hint: "location_pin_unsupported" });
    const att = await normalizeInbound(base({ type: "attachment", name: "cat.jpg", mimeType: "image/jpeg", read: async () => Buffer.alloc(3) }), { speech: false });
    expect(att?.message.content).toEqual({ kind: "other", hint: "unsupported_attachment" });
  });

  it("a native pin outside intake gets the pin copy, not the generic one", async () => {
    const h = makeHarness();
    const { user, guardianId } = await seedUser(h);
    await seedPlan(h, user.id, guardianId, "ARMED");
    expect(await h.inbound(USER, { kind: "other", hint: "location_pin_unsupported" })).toBe("pin_unsupported");
    expect(h.sentTo(USER).at(-1)?.template).toBe("loc_pin_unsupported");
  });

  it("a failed voice note hint gets the voice copy", async () => {
    const h = makeHarness();
    await seedUser(h);
    await h.inbound(USER, { kind: "other", hint: "voice_failed" });
    expect(h.sentTo(USER).at(-1)?.template).toBe("voice_unavailable");
  });
});
