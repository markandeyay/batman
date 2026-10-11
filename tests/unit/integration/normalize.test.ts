// Spec 8.4 step 6 with recorded shapes from docs/spikes/S3_S4.md.
import { describe, expect, it } from "vitest";
import { mapReactionEmoji, normalizeInbound, type RawMessage } from "../../../apps/server/src/gateway/normalize.js";

const FROM = "+13125550100";
const base = (content: RawMessage["content"], extra: Partial<RawMessage> = {}): RawMessage => ({
  id: "spc-msg-11111111-2222-3333-4444-555555555555",
  direction: "inbound",
  platform: "imessage",
  content,
  sender: { id: FROM, address: FROM },
  timestamp: new Date("2026-10-10T23:00:00Z"),
  ...extra,
});
const off = { speech: false };

describe("normalizeInbound", () => {
  it("text", async () => {
    const n = await normalizeInbound(base({ type: "text", text: "ping" }), off);
    expect(n?.message).toEqual({ id: base({ type: "text" }).id, from: FROM, at: new Date("2026-10-10T23:00:00Z"), content: { kind: "text", text: "ping" } });
  });

  it("skips outbound echoes and read receipts", async () => {
    expect(await normalizeInbound(base({ type: "text", text: "x" }, { direction: "outbound" }), off)).toBeNull();
    expect(await normalizeInbound(base({ type: "read", target: { id: "m1" } }), off)).toBeNull();
    expect(await normalizeInbound(base({ type: "typing", state: "start" }), off)).toBeNull();
  });

  it("drops senders without E.164", async () => {
    expect(await normalizeInbound(base({ type: "text", text: "x" }, { sender: { id: "someone@icloud.com" } }), off)).toBeNull();
  });

  it("recorded contact card shape (S4 PASS)", async () => {
    const n = await normalizeInbound(
      base({ type: "contact", name: { formatted: "Priya Shah", first: "Priya" }, phones: [{ value: "+19195550142", type: "cell" }], raw: "BEGIN:VCARD\nFN:Priya Shah\nEND:VCARD", photo: { read: async () => Buffer.alloc(0) } }),
      off,
    );
    expect(n?.message.content).toEqual({ kind: "contact", name: "Priya Shah", phones: ["+19195550142"] });
  });

  it("native Send My Current Location: custom unsupported-message -> other with the pin flag (S4 FAIL)", async () => {
    const n = await normalizeInbound(base({ type: "custom", raw: { imessage_type: "unsupported-message" } }), off);
    expect(n?.message.content).toEqual({ kind: "other", hint: "location_pin_unsupported" });
    expect(n?.flags.locationPinUnsupported).toBe(true);
  });

  it("reaction maps tapback emoji and targets the message id", async () => {
    const n = await normalizeInbound(base({ type: "reaction", emoji: "👍", target: { id: "spc-msg-target" } }, { id: "spc-msg-x:reaction:3" }), off);
    expect(n?.message.content).toEqual({ kind: "reaction", emoji: "like", targetMessageId: "spc-msg-target", removed: false });
    expect(mapReactionEmoji("❤️")).toBe("love");
    expect(mapReactionEmoji("‼️")).toBe("emphasize");
    expect(mapReactionEmoji("😂")).toBe("laugh");
    expect(mapReactionEmoji("👎")).toBe("dislike");
    expect(mapReactionEmoji("❓")).toBe("question");
    expect(mapReactionEmoji("🔥")).toBe("other");
  });

  it("reaction on a group part targets the parent (first part) id", async () => {
    const n = await normalizeInbound(base({ type: "reaction", emoji: "👍", target: { id: "p:1/spc-msg-parent", parentId: "spc-msg-parent" } }), off);
    expect(n?.message.content).toMatchObject({ targetMessageId: "spc-msg-parent" });
  });

  it("voice with speech off -> voice_unavailable", async () => {
    const n = await normalizeInbound(base({ type: "voice", mimeType: "audio/x-caf", read: async () => Buffer.from("caf") }), off);
    expect(n?.message.content).toEqual({ kind: "voice_unavailable" });
    expect(n?.flags.voiceFailed).toBe(true);
  });

  it("voice with speech on -> transcribed text marked fromVoice; failure -> voice_unavailable", async () => {
    const seen: string[] = [];
    const ok = await normalizeInbound(base({ type: "voice", mimeType: "audio/x-caf", read: async () => Buffer.from("caf") }), {
      speech: true,
      transcribe: async (_b, mime) => {
        seen.push(mime);
        return "testing one two three pineapple";
      },
    });
    expect(ok?.message.content).toEqual({ kind: "text", text: "testing one two three pineapple", fromVoice: true });
    expect(seen).toEqual(["audio/x-caf"]);
    const bad = await normalizeInbound(base({ type: "voice", mimeType: "audio/x-caf", read: async () => Buffer.from("caf") }), {
      speech: true,
      transcribe: async () => {
        throw new Error("timeout");
      },
    });
    expect(bad?.message.content).toEqual({ kind: "voice_unavailable" });
  });

  it("location vCard attachment -> location", async () => {
    const vcf = "BEGIN:VCARD\nVERSION:3.0\nFN:Current Location\nitem1.URL;type=pref:http://maps.apple.com/?ll=41.917200\\,-87.706700&q=41.917200\\,-87.706700\nitem1.X-ABLabel:map url\nEND:VCARD";
    const n = await normalizeInbound(base({ type: "attachment", name: "Current Location.loc.vcf", mimeType: "text/vcard", read: async () => Buffer.from(vcf) }), off);
    expect(n?.message.content).toEqual({ kind: "location", lat: 41.9172, lng: -87.7067 });
  });

  it("contact card carrying a maps URL and no phones -> location", async () => {
    const n = await normalizeInbound(base({ type: "contact", name: { formatted: "Dropped Pin" }, urls: ["https://maps.apple.com/?ll=41.9,-87.7"] }), off);
    expect(n?.message.content).toEqual({ kind: "location", lat: 41.9, lng: -87.7 });
  });

  it("other attachments -> other with unsupportedAttachment", async () => {
    const n = await normalizeInbound(base({ type: "attachment", name: "cat.jpg", mimeType: "image/jpeg", read: async () => Buffer.alloc(3) }), off);
    expect(n?.message.content).toEqual({ kind: "other", hint: "unsupported_attachment" });
    expect(n?.flags.unsupportedAttachment).toBe(true);
  });

  it("multi-part group uses the first part id and joins text", async () => {
    const outer = "spc-msg-parent";
    const items: RawMessage[] = [
      { ...base({ type: "text", text: "here is the spot" }), id: `p:0/${outer}`, parentId: outer },
      { ...base({ type: "attachment", name: "cat.jpg", mimeType: "image/jpeg" }), id: `p:1/${outer}`, parentId: outer },
    ];
    const n = await normalizeInbound(base({ type: "group", items }, { id: outer }), off);
    expect(n?.message.id).toBe(outer);
    expect(n?.message.content).toEqual({ kind: "text", text: "here is the spot" });
    expect(n?.flags.unsupportedAttachment).toBe(true);
  });

  it("a single child part keeps its parent id as message id but raw id for dedupe", async () => {
    const n = await normalizeInbound(base({ type: "text", text: "hi" }, { id: "p:1/spc-msg-parent", parentId: "spc-msg-parent" }), off);
    expect(n?.message.id).toBe("spc-msg-parent");
    expect(n?.rawId).toBe("p:1/spc-msg-parent");
  });

  it("rich link with Maps coordinates -> location; plain rich link -> text", async () => {
    const a = await normalizeInbound(base({ type: "richlink", url: "https://www.google.com/maps/@41.9172,-87.7067,15z" }), off);
    expect(a?.message.content).toEqual({ kind: "location", lat: 41.9172, lng: -87.7067 });
    const b = await normalizeInbound(base({ type: "richlink", url: "https://example.com/x" }), off);
    expect(b?.message.content).toEqual({ kind: "text", text: "https://example.com/x" });
  });
});
