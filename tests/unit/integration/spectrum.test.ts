// Inbound loop (spec 8.4 steps 1 to 4, 11.2): skip outbound and read receipts, dedupe through
// processed_inbound, never throw out of the loop, serial per sender. Terminal bridge (16.2).
import { describe, expect, it } from "vitest";
import type { NormalizedInbound } from "../../../apps/server/src/gateway/normalize.js";
import { InboundLoop, installSignalHandlers, type LoopMessage } from "../../../apps/server/src/gateway/spectrum.js";
import { TERMINAL_GUARDIAN_DEFAULT, TERMINAL_USER_DEFAULT, TerminalBridge, TerminalCallService } from "../../../apps/server/src/gateway/terminal.js";
import { openStore } from "../../../apps/server/src/store/db.js";
import { FakeClock, FakeSpace, T0, USER, recLogger } from "./gatewayHelpers.js";

const msg = (id: string, content: LoopMessage["content"], extra: Partial<LoopMessage> = {}): LoopMessage => ({
  id,
  direction: "inbound",
  platform: "imessage",
  content,
  sender: { id: USER, address: USER },
  timestamp: T0,
  react: async () => undefined,
  ...extra,
});

async function* gen(items: [unknown, LoopMessage][], thenThrow?: Error) {
  for (const i of items) yield i;
  if (thenThrow) throw thenThrow;
}

function loop(items: [unknown, LoopMessage][], handler: (n: NormalizedInbound) => Promise<void>, extra: Record<string, unknown> = {}) {
  const store = openStore(":memory:");
  const log = recLogger();
  const l = new InboundLoop({
    messages: gen(items),
    store,
    clock: new FakeClock(T0),
    normalize: { speech: false },
    resolveFrom: (m) => (m.sender?.address as never) ?? null,
    handler: () => handler,
    logger: log,
    sleep: async () => {},
    ...extra,
  });
  return { l, store, log };
}

describe("InboundLoop", () => {
  it("skips outbound and read receipts, dedupes by message id, handles the rest", async () => {
    const seen: string[] = [];
    const { l, store } = loop(
      [
        [{}, msg("a", { type: "text", text: "hi" })],
        [{}, msg("a", { type: "text", text: "hi" })],
        [{}, msg("b", { type: "text", text: "echo" }, { direction: "outbound" })],
        [{}, msg("c", { type: "read", target: { id: "x" } })],
        [{}, msg("d", { type: "text", text: "there" })],
      ],
      async (n) => void seen.push(n.message.id),
    );
    for (const [s, m] of [
      [{}, msg("a", { type: "text", text: "hi" })],
      [{}, msg("a", { type: "text", text: "hi" })],
      [{}, msg("b", { type: "text", text: "echo" }, { direction: "outbound" })],
      [{}, msg("c", { type: "read", target: { id: "x" } })],
      [{}, msg("d", { type: "text", text: "there" })],
    ] as const)
      await l.accept(s, m);
    await l.drain();
    expect(seen).toEqual(["a", "d"]);
    expect(l.stats.duplicates).toBe(1);
    // dedupe survives a restart because it lives in the store
    const again = new InboundLoop({
      messages: gen([]),
      store,
      clock: new FakeClock(T0),
      normalize: { speech: false },
      resolveFrom: () => USER,
      handler: () => async (n) => void seen.push(`again:${n.message.id}`),
    });
    await again.accept({}, msg("a", { type: "text", text: "hi" }));
    await again.drain();
    expect(seen).toEqual(["a", "d"]);
  });

  it("a throwing handler never escapes; a stream error restarts the loop", async () => {
    const seen: string[] = [];
    let calls = 0;
    const { l, log } = loop([], async (n) => {
      seen.push(n.message.id);
      throw new Error("handler blew up");
    });
    await l.accept({}, msg("x", { type: "text", text: "1" }));
    await l.accept({}, msg("y", { type: "text", text: "2" }));
    await l.drain();
    expect(seen).toEqual(["x", "y"]);
    expect(l.stats.handlerErrors).toBe(2);
    expect(log.lines.some((x) => x.level === "error")).toBe(true);

    const it2 = {
      [Symbol.asyncIterator]() {
        calls++;
        if (calls === 1) return gen([[{}, msg("s1", { type: "text", text: "a" })]], new Error("stream reset"));
        if (calls === 2) return gen([[{}, msg("s2", { type: "text", text: "b" })]]);
        r.stop();
        return gen([]);
      },
    };
    const got: string[] = [];
    const r = new InboundLoop({
      messages: it2 as AsyncIterable<[unknown, LoopMessage]>,
      store: openStore(":memory:"),
      clock: new FakeClock(T0),
      normalize: { speech: false },
      resolveFrom: () => USER,
      handler: () => async (n) => void got.push(n.message.id),
      sleep: async () => {},
    });
    await r.start();
    await r.drain();
    expect(got).toEqual(["s1", "s2"]);
    expect(r.stats.streamErrors).toBe(1);
  });

  it("processes one sender serially", async () => {
    const order: string[] = [];
    const { l } = loop([], async (n) => {
      order.push(`start:${n.message.id}`);
      await new Promise((r) => setTimeout(r, n.message.id === "slow" ? 20 : 0));
      order.push(`end:${n.message.id}`);
    });
    await l.accept({}, msg("slow", { type: "text", text: "1" }));
    await l.accept({}, msg("fast", { type: "text", text: "2" }));
    await l.drain();
    expect(order).toEqual(["start:slow", "end:slow", "start:fast", "end:fast"]);
  });

  it("installSignalHandlers registers SIGINT, SIGBREAK, SIGTERM and uninstalls", () => {
    const before = process.listenerCount("SIGTERM");
    const off = installSignalHandlers(() => {});
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    off();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("TerminalBridge", () => {
  it("maps the console sender to test addresses and switches with /as", async () => {
    const b = new TerminalBridge();
    const space = new FakeSpace("chat-1");
    space.kind = "terminal";
    b.setSpace(space);
    const t = (text: string): LoopMessage => msg("t", { type: "text", text }, { platform: "terminal", sender: { id: "console" } });
    expect(b.resolveFrom(t("hi"))).toBe(TERMINAL_USER_DEFAULT);
    expect(await b.intercept(t("/as guardian"), undefined)).toBe(true);
    expect(b.resolveFrom(t("YES"))).toBe(TERMINAL_GUARDIAN_DEFAULT);
    expect(await b.intercept(t("YES"), undefined)).toBe(false);
    expect(await b.intercept(t("/as user"), undefined)).toBe(true);
    expect(b.current).toBe("user");
    const g = await b.resolve(TERMINAL_GUARDIAN_DEFAULT);
    await g.send("Alex hasn't replied");
    expect(space.sent).toContain("[to guardian] Alex hasn't replied");
    expect(b.handles(USER)).toBe(false);
  });

  it("stubbed calls print [CALL -> user: script]", async () => {
    const b = new TerminalBridge();
    const space = new FakeSpace("chat-1");
    b.setSpace(space);
    const placed = await new TerminalCallService(b).place(TERMINAL_USER_DEFAULT, "fake", { decoy: "roommate", userName: "Alex" });
    expect(placed).toBe(true);
    expect(space.sent[0]).toMatch(/^\[CALL -> user: fake call script\]/);
  });
});
