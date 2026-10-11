// Spectrum Message -> contracts InboundMessage (spec 8.4 steps 2, 3, 6; Spikes S3, S4).
//
// Pure apart from the injected transcriber. Recorded shapes (docs/spikes/S3_S4.md):
//   - text: { type: "text", text }
//   - contact card: { type: "contact", name: { formatted }, phones: [{ value }], raw: vcard }
//   - "Send My Current Location": { type: "custom", raw: { imessage_type: "unsupported-message" } }
//   - reaction: { type: "reaction", emoji: "👍", target: Message } (only reactionAdded is surfaced)
//   - read receipt: { type: "read", target } -> null, never reply
//   - multi-part (text plus attachments): one Message with { type: "group", items: Message[] }
//     whose items have ids "p:<i>/<guid>"; the InboundMessage id is the outer (first part) guid.
// Outbound echoes are skipped.
import type { E164, InboundContent, InboundMessage, ReactionEmoji } from "../contracts.js";
import { isLocationVCardName, parsePin } from "../location/pin.js";

/** Structural subset of spectrum-ts Message that normalization reads. */
export interface RawMessage {
  id: string;
  direction: "inbound" | "outbound";
  platform: string;
  content: RawContent;
  sender?: { id: string; address?: string | undefined } | undefined;
  timestamp: Date | string;
  parentId?: string | undefined;
}

export interface RawContent {
  type: string;
  [k: string]: unknown;
}

/** Hints the dialogue can see beyond the contracts union (proposed for contracts.ts). */
export interface InboundFlags {
  /** Native "Send My Current Location" pin (custom unsupported-message): reply loc_pin_unsupported. */
  locationPinUnsupported?: true;
  /** A voice note arrived but speech is off or STT failed: reply voice_unavailable, AMBIGUOUS in CHECKING. */
  voiceFailed?: true;
  /** An attachment that is not a location card: reply unsupported_content. */
  unsupportedAttachment?: true;
  /** Location came from a contact card / vCard rather than a link. */
  locationFrom?: "maps_url" | "vcard_geo" | "geo_uri";
}

export interface NormalizedInbound {
  message: InboundMessage;
  /** Raw platform id of this exact message (dedupe key; differs from message.id for group parts). */
  rawId: string;
  platform: string;
  /** Spectrum content type of the outer message. */
  contentType: string;
  flags: InboundFlags;
}

export interface NormalizeOptions {
  /** capabilities(env).speech */
  speech: boolean;
  /** speech/stt.ts transcribe, injected. Required when speech is true. */
  transcribe?: (bytes: Buffer, mime: string) => Promise<string>;
  /** Map a sender to an E.164 (terminal mode maps console ids). Default: sender.address ?? sender.id. */
  resolveFrom?: (m: RawMessage) => E164 | null;
  onVoiceError?: (err: unknown) => void;
}

const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Tapback emoji table from @spectrum-ts/imessage EMOJI_TO_TAPBACK (plus bare variants). */
const EMOJI_MAP: Record<string, ReactionEmoji> = {
  "❤️": "love",
  "❤": "love",
  "👍": "like",
  "👎": "dislike",
  "😂": "laugh",
  "‼️": "emphasize",
  "‼": "emphasize",
  "❓": "question",
  love: "love",
  like: "like",
  dislike: "dislike",
  laugh: "laugh",
  emphasize: "emphasize",
  question: "question",
};

export function mapReactionEmoji(emoji: string): ReactionEmoji {
  return EMOJI_MAP[emoji] ?? EMOJI_MAP[emoji.replace(/️/g, "")] ?? "other";
}

/** Content types that are control signals, never user turns (8.4 step 3 and PHOTON_NOTES mismatch 7). */
const IGNORED = new Set(["read", "typing", "edit", "unsend", "rename", "avatar", "addMember", "removeMember", "leaveSpace", "streamText", "poll_option", "poll"]);

export function defaultResolveFrom(m: RawMessage): E164 | null {
  const a = m.sender?.address ?? m.sender?.id;
  return typeof a === "string" && E164_RE.test(a) ? (a as E164) : null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

interface PartResult {
  content: InboundContent;
  flags: InboundFlags;
}

async function normalizePart(c: RawContent, o: NormalizeOptions): Promise<PartResult | null> {
  switch (c.type) {
    case "text": {
      const text = str(c.text) ?? "";
      return { content: { kind: "text", text }, flags: {} };
    }
    case "markdown":
      return { content: { kind: "text", text: str(c.markdown) ?? "" }, flags: {} };
    case "richlink": {
      // A pasted Maps link may arrive as a rich link. Coordinates win; else it is just text.
      const url = str(c.url) ?? "";
      const pin = parsePin({ urls: [url] });
      if (pin) return { content: { kind: "location", lat: pin.lat, lng: pin.lng }, flags: { locationFrom: pin.source } };
      return { content: { kind: "text", text: url }, flags: {} };
    }
    case "voice": {
      if (!o.speech || !o.transcribe || typeof c.read !== "function") return { content: { kind: "voice_unavailable" }, flags: { voiceFailed: true } };
      try {
        const bytes = (await (c.read as () => Promise<Buffer>)()) ?? Buffer.alloc(0);
        const text = await o.transcribe(bytes, str(c.mimeType) ?? "audio/x-caf");
        return { content: { kind: "text", text, fromVoice: true }, flags: {} };
      } catch (err) {
        o.onVoiceError?.(err);
        return { content: { kind: "voice_unavailable" }, flags: { voiceFailed: true } };
      }
    }
    case "contact": {
      const urls = Array.isArray(c.urls) ? (c.urls as unknown[]).filter((u): u is string => typeof u === "string") : [];
      const raw = str(c.raw);
      const pin = parsePin({ urls, vcf: raw });
      const phones = Array.isArray(c.phones)
        ? (c.phones as unknown[]).map((p) => str((p as { value?: unknown })?.value)).filter((p): p is string => !!p)
        : [];
      // A location card (.loc.vcf parsed by the SDK) carries coordinates and no phone numbers.
      if (pin && phones.length === 0) return { content: { kind: "location", lat: pin.lat, lng: pin.lng }, flags: { locationFrom: pin.source } };
      const nameObj = (c.name ?? {}) as { formatted?: unknown; first?: unknown; last?: unknown };
      const name = str(nameObj.formatted) ?? ([str(nameObj.first), str(nameObj.last)].filter(Boolean).join(" ") || null);
      return { content: { kind: "contact", name, phones }, flags: {} };
    }
    case "attachment": {
      const name = str(c.name);
      const mime = (str(c.mimeType) ?? "").toLowerCase();
      if (isLocationVCardName(name) || /vcard|x-vcard|directory/.test(mime)) {
        try {
          const bytes = typeof c.read === "function" ? await (c.read as () => Promise<Buffer>)() : undefined;
          const pin = bytes ? parsePin({ vcf: bytes.toString("utf8") }) : undefined;
          if (pin) return { content: { kind: "location", lat: pin.lat, lng: pin.lng }, flags: { locationFrom: pin.source } };
        } catch {
          // fall through to unsupported
        }
      }
      return { content: { kind: "other" }, flags: { unsupportedAttachment: true } };
    }
    case "custom": {
      const raw = (c.raw ?? {}) as { imessage_type?: unknown };
      if (raw.imessage_type === "unsupported-message") return { content: { kind: "other" }, flags: { locationPinUnsupported: true } };
      return { content: { kind: "other" }, flags: {} };
    }
    case "reply": {
      const inner = c.content as RawContent | undefined;
      return inner && typeof inner.type === "string" ? normalizePart(inner, o) : null;
    }
    case "effect": {
      const inner = c.content as RawContent | undefined;
      return inner && typeof inner.type === "string" ? normalizePart(inner, o) : null;
    }
    default:
      return IGNORED.has(c.type) ? null : { content: { kind: "other" }, flags: {} };
  }
}

const PRIORITY: Record<InboundContent["kind"], number> = { location: 0, text: 1, voice_unavailable: 2, contact: 3, reaction: 4, other: 5 };

/**
 * Normalize one Spectrum message. Returns null for outbound echoes, read receipts and other
 * control signals, and senders without an E.164 address.
 */
export async function normalizeInbound(m: RawMessage, o: NormalizeOptions): Promise<NormalizedInbound | null> {
  if (m.direction === "outbound") return null;
  const c = m.content;
  if (!c || typeof c.type !== "string" || IGNORED.has(c.type)) return null;
  const from = (o.resolveFrom ?? defaultResolveFrom)(m);
  if (!from) return null;
  const at = m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp);
  const id = m.parentId ?? m.id;
  const base = { rawId: m.id, platform: m.platform, contentType: c.type };

  if (c.type === "reaction") {
    const target = c.target as { id?: unknown; parentId?: unknown } | undefined;
    const targetId = str(target?.parentId) ?? str(target?.id);
    if (!targetId) return null;
    const content: InboundContent = { kind: "reaction", emoji: mapReactionEmoji(str(c.emoji) ?? ""), targetMessageId: targetId, removed: false };
    return { ...base, message: { id, from, at, content }, flags: {} };
  }

  if (c.type === "group") {
    const items = Array.isArray(c.items) ? (c.items as RawMessage[]) : [];
    const parts: PartResult[] = [];
    for (const it of items) {
      if (!it?.content) continue;
      const r = await normalizePart(it.content, o);
      if (r) parts.push(r);
    }
    if (parts.length === 0) return null;
    const texts = parts.filter((p) => p.content.kind === "text").map((p) => (p.content as { text: string }).text.trim()).filter(Boolean);
    const best = [...parts].sort((a, b) => PRIORITY[a.content.kind] - PRIORITY[b.content.kind])[0]!;
    const flags = Object.assign({}, ...parts.map((p) => p.flags)) as InboundFlags;
    let content = best.content;
    if (content.kind === "text") {
      const fromVoice = parts.some((p) => p.content.kind === "text" && p.content.fromVoice);
      content = fromVoice ? { kind: "text", text: texts.join("\n"), fromVoice: true } : { kind: "text", text: texts.join("\n") };
    }
    return { ...base, message: { id: m.id, from, at, content }, flags };
  }

  const r = await normalizePart(c, o);
  if (!r) return null;
  return { ...base, message: { id, from, at, content: r.content }, flags: r.flags };
}
