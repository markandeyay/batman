// Spec 11.3: token minting, zod validation, refresh at 80% of expiresIn, address selection.
import { describe, expect, it } from "vitest";
import {
  TokenManager,
  createImessageClient,
  dmChatGuid,
  mintImessageToken,
  toMessageGuid,
  type FetchLike,
  type TokenData,
} from "../../../apps/server/src/gateway/imessageAdvanced.js";

const fetchReturning = (bodies: unknown[], calls: string[] = []): FetchLike => async (url, init) => {
  calls.push(`${init.method} ${url} ${init.headers.authorization?.slice(0, 6)}`);
  const body = bodies.shift();
  return { status: 200, json: async () => body };
};

describe("advanced-imessage client factory", () => {
  it("mints a shared token with Basic auth and validates the envelope", async () => {
    const calls: string[] = [];
    const d = await mintImessageToken("proj", "secret", fetchReturning([{ succeed: true, data: { type: "shared", token: "tok", expiresIn: 900 } }], calls));
    expect(d).toEqual({ type: "shared", token: "tok", expiresIn: 900 });
    expect(calls).toEqual(["POST https://spectrum.photon.codes/projects/proj/imessage/tokens Basic "]);
  });

  it("rejects malformed token responses", async () => {
    await expect(mintImessageToken("p", "s", fetchReturning([{ data: { type: "shared", expiresIn: 900 } }]))).rejects.toThrow(/unexpected response/);
    const bad: FetchLike = async () => ({ status: 401, json: async () => ({}) });
    await expect(mintImessageToken("p", "s", bad)).rejects.toThrow(/HTTP 401/);
  });

  it("refreshes at 80% of expiresIn and shares one in-flight mint", async () => {
    let now = 0;
    let n = 0;
    const tm = new TokenManager(async (): Promise<TokenData> => ({ type: "shared", token: `t${++n}`, expiresIn: 900 }), () => now);
    const [a, b] = await Promise.all([tm.token(), tm.token()]);
    expect([a, b, n]).toEqual(["t1", "t1", 1]);
    now = 719_000;
    expect(await tm.token()).toBe("t1");
    now = 720_000; // 80% of 900 s
    expect(await tm.token()).toBe("t2");
  });

  it("shared tokens use IMESSAGE_GRPC_ADDRESS with tls and an async token", async () => {
    const seen: Record<string, unknown>[] = [];
    const c = await createImessageClient({
      projectId: "p",
      projectSecret: "s",
      sharedAddress: "imessage.spectrum.photon.codes:443",
      fetch: fetchReturning([{ data: { type: "shared", token: "tok", expiresIn: 900 } }]),
      createClient: (o) => {
        seen.push(o as unknown as Record<string, unknown>);
        return { close: async () => {} } as never;
      },
    });
    expect(c.address).toBe("imessage.spectrum.photon.codes:443");
    expect(seen[0]).toMatchObject({ address: "imessage.spectrum.photon.codes:443", tls: true, retry: true, autoIdempotency: true });
    expect(await (seen[0]!.token as () => Promise<string>)()).toBe("tok");
  });

  it("dedicated tokens use {instanceId}.imsg.photon.codes:443", async () => {
    const c = await createImessageClient({
      projectId: "p",
      projectSecret: "s",
      sharedAddress: "unused:443",
      fetch: fetchReturning([{ data: { type: "dedicated", auth: { "line-1": "t" }, numbers: { "line-1": "+15555550199" }, expiresIn: 900 } }]),
      createClient: () => ({ close: async () => {} }) as never,
    });
    expect(c.address).toBe("line-1.imsg.photon.codes:443");
  });

  it("guid helpers", () => {
    expect(dmChatGuid("+13125550100")).toBe("any;-;+13125550100");
    expect(toMessageGuid("p:2/spc-msg-abc")).toBe("spc-msg-abc");
    expect(toMessageGuid("spc-msg-abc")).toBe("spc-msg-abc");
  });
});
