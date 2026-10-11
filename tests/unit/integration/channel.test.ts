// Spec 8.5 send rules: retry classification, quotas, stop checks, tapbacks, Notify Anyway.
import { describe, expect, it } from "vitest";
import { CRITICAL_RETRY_DELAYS_MS, QUOTA, QuotaGate, dayKey, withRetry } from "../../../apps/server/src/gateway/channel.js";
import {
  EmergencyNumberError,
  PoolNumberError,
  QuotaExceededError,
  StoppedRecipientError,
  TargetNotAllowedError,
  describeError,
  isEmergencyNumber,
  isRetryable,
  isShareEnded,
} from "../../../apps/server/src/gateway/errors.js";
import * as repo from "../../../apps/server/src/store/repo.js";
import { openStore } from "../../../apps/server/src/store/db.js";
import { FakeClock, GUARDIAN, POOL_NUMBER, T0, TARGET_NOT_ALLOWED, UNAVAILABLE, USER, imErr, makeChannel } from "./gatewayHelpers.js";

describe("error classification", () => {
  it("PERMISSION_DENIED target not allowed is never retryable, even if the SDK says otherwise", () => {
    const e = TARGET_NOT_ALLOWED();
    (e as unknown as { retryable: boolean }).retryable = true;
    expect(describeError(e)).toMatchObject({ kind: "target_not_allowed", retryable: false, grpcCode: 7 });
  });
  it("pool-number ValidationError is never retryable", () => {
    expect(describeError(POOL_NUMBER())).toMatchObject({ kind: "pool_number", retryable: false });
  });
  it("UNAVAILABLE retries; INVALID_ARGUMENT and NOT_FOUND do not; plain network errors retry", () => {
    expect(isRetryable(UNAVAILABLE())).toBe(true);
    expect(isRetryable(imErr("bad", 3, false))).toBe(false);
    expect(isRetryable(imErr("gone", 5, false))).toBe(false);
    expect(isRetryable(new Error("fetch failed"))).toBe(true);
    expect(isRetryable(new Error("something odd"))).toBe(false);
  });
  it("redacts phone numbers in messages", () => {
    expect(describeError(new Error("send to +19195550142 failed")).message).toBe("send to ***0142 failed");
  });
  it("share ended detection", () => {
    expect(isShareEnded(imErr("[upstream] Address is not currently sharing a location", 5, false, "NotFoundError"))).toBe(true);
    expect(isShareEnded(UNAVAILABLE())).toBe(false);
  });
  it("I6 emergency numbers", () => {
    for (const n of ["911", "+1911", "112", "+112", "999", "+1911555", "988", "+12115550000"]) expect(isEmergencyNumber(n), n).toBe(true);
    expect(isEmergencyNumber(USER)).toBe(false);
    expect(isEmergencyNumber("+447700900123")).toBe(false);
  });
});

describe("withRetry", () => {
  it("retries only retryable errors, 3 attempts", async () => {
    let n = 0;
    const sleeps: number[] = [];
    await expect(
      withRetry(
        async () => {
          n++;
          throw UNAVAILABLE();
        },
        { delays: [1, 2], sleep: async (ms) => void sleeps.push(ms) },
      ),
    ).rejects.toThrow();
    expect(n).toBe(3);
    expect(sleeps).toEqual([1, 2]);
    n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw TARGET_NOT_ALLOWED();
        },
        { delays: [1, 2], sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(n).toBe(1);
  });
  it("critical schedule is 10 attempts over 5 minutes", () => {
    expect(CRITICAL_RETRY_DELAYS_MS.length + 1).toBe(10);
    expect(CRITICAL_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(300_000);
  });
});

describe("GatewayChannel", () => {
  const setup = () => {
    const store = openStore(":memory:");
    const clock = new FakeClock(T0);
    return { store, clock, ...makeChannel(store, clock) };
  };

  it("sends, returns the platform id, caches the space, records counters and a row", async () => {
    const t = setup();
    const a = await t.channel.sendText(USER, "hi");
    const b = await t.channel.sendText(USER, "again");
    expect(a.id).toMatch(/^spc-msg-/);
    expect(b.id).not.toBe(a.id);
    expect(t.resolver.resolves).toBe(1);
    expect(repo.getCounter(t.store, dayKey(T0), "msg_out")).toBe(2);
    expect(repo.getCounter(t.store, dayKey(T0), "new_conv")).toBe(1);
    const rows = t.store.sqlite.prepare("SELECT kind, body_redacted FROM messages WHERE direction='outbound'").all();
    expect(rows).toHaveLength(2);
  });

  it("retries a retryable failure (3 attempts), then succeeds", async () => {
    const t = setup();
    t.resolver.space(USER).failures.push(UNAVAILABLE, UNAVAILABLE);
    await t.channel.sendText(USER, "hi");
    expect(t.sleeps).toEqual([1000, 3000]);
  });

  it("never retries PERMISSION_DENIED; surfaces TargetNotAllowedError", async () => {
    const t = setup();
    t.resolver.space(GUARDIAN).failures.push(TARGET_NOT_ALLOWED);
    await expect(t.channel.sendText(GUARDIAN, "hi")).rejects.toBeInstanceOf(TargetNotAllowedError);
    expect(t.sleeps).toEqual([]);
  });

  it("never retries a pool-number ValidationError; surfaces PoolNumberError", async () => {
    const t = setup();
    t.resolver.space(GUARDIAN).failures.push(POOL_NUMBER);
    await expect(t.channel.send(GUARDIAN, "alert", { critical: true })).rejects.toBeInstanceOf(PoolNumberError);
    expect(t.sleeps).toEqual([]);
  });

  it("critical sends retry up to 10 times and log a critical error", async () => {
    const t = setup();
    for (let i = 0; i < 12; i++) t.resolver.space(GUARDIAN).failures.push(UNAVAILABLE);
    await expect(t.channel.send(GUARDIAN, "alert", { critical: true })).rejects.toThrow();
    expect(t.sleeps).toEqual([...CRITICAL_RETRY_DELAYS_MS]);
    expect(t.log.lines.some((l) => l.level === "error" && l.obj.critical === true)).toBe(true);
  });

  it("I14: drops sends to a stopped address at send time, except stop_ack", async () => {
    const t = setup();
    t.stopped.add(USER);
    await expect(t.channel.sendText(USER, "hi")).rejects.toBeInstanceOf(StoppedRecipientError);
    await expect(t.channel.send(USER, "You're unsubscribed", { bypassStop: true, kind: "stop_ack" })).resolves.toBeTruthy();
    expect(t.resolver.space(USER).sent).toEqual(["You're unsubscribed"]);
  });

  it("I6: refuses emergency numbers", async () => {
    const t = setup();
    await expect(t.channel.sendText("+1911" as never, "hi")).rejects.toBeInstanceOf(EmergencyNumberError);
  });

  it("quota: near 5,000 per day only safety sends proceed", async () => {
    const t = setup();
    repo.incrementCounter(t.store, dayKey(T0), "msg_out", Math.floor(QUOTA.messagesPerDay * QUOTA.nearRatio));
    await expect(t.channel.sendText(USER, "hello")).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(t.channel.send(USER, "Hey, you good?", { safety: true })).resolves.toBeTruthy();
    await expect(t.channel.send(GUARDIAN, "alert", { critical: true })).resolves.toBeTruthy();
  });

  it("quota: near 50 new conversations, new addresses wait but existing conversations continue", async () => {
    const t = setup();
    await t.channel.sendText(USER, "first"); // existing conversation now
    repo.incrementCounter(t.store, dayKey(T0), "new_conv", 48);
    await expect(t.channel.sendText(GUARDIAN, "hello")).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(t.channel.sendText(USER, "still fine")).resolves.toBeTruthy();
    const gate = new QuotaGate(t.store, t.clock);
    expect(gate.allowNewConversation()).toBe(false);
  });

  it("react uses the remembered inbound Message", async () => {
    const t = setup();
    const reacted: string[] = [];
    t.channel.rememberInbound("p:0/spc-msg-in", { react: async (e) => void reacted.push(e) }, "spc-msg-in");
    await t.channel.react("spc-msg-in", "like");
    await t.channel.react("unknown", "like");
    expect(reacted).toEqual(["👍"]);
  });

  it("typing wraps space.responding; shareContactCard calls the space action", async () => {
    const t = setup();
    expect(await t.channel.typing(USER, async () => 7)).toBe(7);
    await t.channel.shareContactCard(USER);
    expect(t.resolver.space(USER).responded).toBe(1);
    expect(t.resolver.space(USER).shared).toBe(1);
  });

  it("notifyAnyway: only when Focus is on, with the chat guid and the Spectrum id as message guid", async () => {
    const t = setup();
    const sent = await t.channel.sendText(USER, "Hey, you good?");
    await t.channel.notifyAnyway(USER, sent);
    expect(t.focus.notified).toEqual([]);
    t.focus.silenced.add(USER);
    await t.channel.notifyAnyway(USER, sent);
    expect(t.focus.notified).toEqual([{ chat: `any;-;${USER}`, message: sent.id }]);
  });

  it("notifyAnyway never throws", async () => {
    const t = setup();
    t.focus.addresses.isFocusSilenced = async () => {
      throw TARGET_NOT_ALLOWED();
    };
    await expect(t.channel.notifyAnyway(USER, { id: "spc-msg-1", at: T0 })).resolves.toBeUndefined();
  });
});
