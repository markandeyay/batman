// Read receipts (human request, 2026-10-10): every accepted, deduped inbound chat is marked read
// so the user sees "Read". Best effort: never blocks, never throws (spec 8.4 is unaffected).
// Verified SDK: @photon-ai/advanced-imessage 2.2.0 grpc.d.ts ChatsResource.markRead(chat: string):
// Promise<void>; a DM chat GUID is any;-;<E164>.
import { describe, expect, it } from "vitest";
import { createApp } from "../../../apps/server/src/app.js";
import { EnvSchema } from "../../../apps/server/src/config/env.js";
import { markInboundRead } from "../../../apps/server/src/gateway/readReceipts.js";
import type { LoopMessage } from "../../../apps/server/src/gateway/spectrum.js";
import { openStore } from "../../../apps/server/src/store/db.js";
import type { Logger } from "../../../apps/server/src/util/log.js";
import { FakeResolver, T0, USER, recLogger } from "./gatewayHelpers.js";

class FakeChats {
  marked: string[] = [];
  constructor(private readonly mode: "ok" | "reject" | "throw" | "hang" = "ok") {}
  markRead(chat: string): Promise<void> {
    this.marked.push(chat);
    if (this.mode === "throw") throw new Error("sync boom");
    if (this.mode === "reject") return Promise.reject(new Error("PERMISSION_DENIED"));
    if (this.mode === "hang") return new Promise(() => {});
    return Promise.resolve();
  }
}

describe("markInboundRead", () => {
  it("marks the DM chat any;-;<E164> as read", async () => {
    const chats = new FakeChats();
    markInboundRead({ chats }, USER);
    expect(chats.marked).toEqual([`any;-;${USER}`]);
  });

  it.each(["reject", "throw", "hang"] as const)("never throws or blocks when markRead does %s", async (mode) => {
    const chats = new FakeChats(mode);
    const warnings: string[] = [];
    const log = { warn: (_o: Record<string, unknown>, msg?: string) => void warnings.push(msg ?? "") };
    expect(() => markInboundRead({ chats }, USER, log)).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    if (mode !== "hang") expect(warnings).toEqual(["markRead failed"]);
  });

  it("is a no-op without an advanced client", () => {
    expect(() => markInboundRead(null, USER)).not.toThrow();
  });
});

describe("app wiring", () => {
  const env = EnvSchema.parse({
    SPECTRUM_PROJECT_ID: "proj",
    SPECTRUM_PROJECT_SECRET: "secret",
    BATMAN_LINE_E164: "+15555550199",
    LLM_MODEL_SMART: "claude-opus-5-5",
    ANTHROPIC_API_KEY: "x",
    LOCATION_SOURCE: "none",
  });

  it("marks each accepted inbound read once, after dedupe, and skips outbound and receipts", async () => {
    const chats = new FakeChats();
    const msg = (id: string, extra: Partial<LoopMessage> = {}): LoopMessage => ({
      id,
      direction: "inbound",
      platform: "imessage",
      content: { type: "text", text: "hi" },
      sender: { id: USER, address: USER },
      timestamp: T0,
      react: async () => undefined,
      ...extra,
    });
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const items = [msg("m1"), msg("m1"), msg("m2", { direction: "outbound" }), msg("m3", { content: { type: "read" } as never }), msg("m4")];
    const sp = {
      messages: {
        async *[Symbol.asyncIterator]() {
          for (const m of items) yield [{ id: `any;-;${USER}` }, m] as [unknown, LoopMessage];
          await stopped;
        },
      },
      async stop() {
        stop();
      },
    };
    const app = createApp(env, {
      store: openStore(":memory:"),
      logger: recLogger() as unknown as Logger,
      spectrumFactory: async () => sp as never,
      imessageClientFactory: async () => ({ im: { chats, locations: {} } as never, close: async () => {} }),
      resolver: new FakeResolver(),
      signals: false,
      sleep: async () => {},
    });
    app.onInbound(async () => {});
    await app.start();
    await new Promise((r) => setTimeout(r, 20));
    await app.inbound!.drain();
    expect(chats.marked).toEqual([`any;-;${USER}`, `any;-;${USER}`]); // m1 and m4 only
    await app.stop("test");
  });
});
