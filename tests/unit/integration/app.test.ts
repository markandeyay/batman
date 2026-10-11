// createApp assembly with fakes (no network): start, inbound hook, sends, stop and lock release.
import { describe, expect, it } from "vitest";
import { createApp, storeStopList } from "../../../apps/server/src/app.js";
import { EnvSchema } from "../../../apps/server/src/config/env.js";
import type { NormalizedInbound } from "../../../apps/server/src/gateway/normalize.js";
import type { LoopMessage } from "../../../apps/server/src/gateway/spectrum.js";
import { openStore } from "../../../apps/server/src/store/db.js";
import type { Logger } from "../../../apps/server/src/util/log.js";
import { FakeResolver, T0, USER, recLogger } from "./gatewayHelpers.js";

const env = EnvSchema.parse({
  SPECTRUM_PROJECT_ID: "proj",
  SPECTRUM_PROJECT_SECRET: "secret",
  BATMAN_LINE_E164: "+15555550199",
  LLM_MODEL_SMART: "claude-opus-5-5",
  ANTHROPIC_API_KEY: "x",
  LOCATION_SOURCE: "none",
});

function fakeSpectrum(items: LoopMessage[]) {
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  return {
    stops: 0,
    messages: {
      async *[Symbol.asyncIterator]() {
        for (const m of items) yield [{ id: `any;-;${USER}` }, m] as [unknown, LoopMessage];
        await stopped;
      },
    },
    async stop() {
      this.stops++;
      stop();
    },
  };
}

describe("createApp", () => {
  it("starts with fakes, routes inbound to onInbound, sends via the channel, stops cleanly", async () => {
    const store = openStore(":memory:");
    const resolver = new FakeResolver();
    const sp = fakeSpectrum([
      { id: "spc-msg-1", direction: "inbound", platform: "imessage", content: { type: "text", text: "hi" }, sender: { id: USER, address: USER }, timestamp: T0, react: async () => undefined },
    ]);
    const app = createApp(env, {
      store,
      logger: recLogger() as unknown as Logger,
      spectrumFactory: async () => sp as never,
      imessageClientFactory: null,
      resolver,
      signals: false,
      sleep: async () => {},
    });
    const got: NormalizedInbound[] = [];
    app.onInbound(async (m) => void got.push(m));
    await app.start();
    await new Promise((r) => setTimeout(r, 20));
    await app.inbound!.drain();
    expect(got.map((m) => m.message.content)).toEqual([{ kind: "text", text: "hi" }]);
    expect(app.caps.speech).toBe(false);

    await app.sendText(USER, "hello back");
    expect(resolver.space(USER).sent).toEqual(["hello back"]);

    storeStopList(store).setStopped(USER, true);
    expect(await app.sendText(USER, "dropped")).toBeNull();
    expect(resolver.space(USER).sent).toEqual(["hello back"]);

    await app.stop("test");
    expect(sp.stops).toBe(1);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM locks").get()).toEqual({ n: 0 });
  });
});
