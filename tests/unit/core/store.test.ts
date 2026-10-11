import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LockHeldError,
  LOCK_STALE_MS,
  acquireLock,
  heartbeatLock,
  migrate,
  openStore,
  releaseLock,
  schemaVersionOf,
  type Store,
} from "../../../apps/server/src/store/db.js";
import { MIGRATIONS } from "../../../apps/server/src/store/migrations.js";
import * as repo from "../../../apps/server/src/store/repo.js";
import { drizzleColumns } from "../../../apps/server/src/store/schema.js";
import { T0, at, basePlan, fixAt } from "./helpers.js";

const dirs: string[] = [];
const stores: Store[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "batman-store-"));
  dirs.push(d);
  return d;
}
function mem(): Store {
  const s = openStore(":memory:");
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(st: Store) {
  const user = repo.createUser(st, { addressE164: "+13125550100", displayName: "Alex", now: T0, id: "user-1" });
  const g = repo.upsertGuardian(st, { addressE164: "+19195550142", displayName: "Priya", now: T0 });
  repo.setGuardianLink(st, { userId: user.id, guardianId: g.id, status: "accepted", now: T0 });
  const plan = repo.insertPlan(st, basePlan({ guardianId: g.id }));
  return { user, g, plan };
}

describe("store: open and migrate", () => {
  it("creates the DATABASE_PATH directory, enables WAL and foreign keys", () => {
    const dir = join(tempDir(), "nested", "data");
    const st = openStore(join(dir, "batman.db"));
    stores.push(st);
    expect(existsSync(dir)).toBe(true);
    expect(st.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(st.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("migrations run once and record schema_version", () => {
    const st = mem();
    expect(schemaVersionOf(st.sqlite)).toBe(MIGRATIONS.at(-1)!.version);
    expect(migrate(st.sqlite)).toEqual([]);
  });

  it("re-opening a file database does not re-apply migrations", () => {
    const path = join(tempDir(), "b.db");
    openStore(path).close();
    const st = openStore(path);
    stores.push(st);
    expect(st.sqlite.prepare("SELECT COUNT(*) AS n FROM schema_version").get()).toEqual({ n: MIGRATIONS.length });
  });

  it("SQL migrations match the Drizzle schema column for column", () => {
    const st = mem();
    for (const [name, cols] of Object.entries(drizzleColumns())) {
      const sqlCols = (st.sqlite.prepare(`PRAGMA table_info(${name})`).all() as { name: string; notnull: number }[]).map((c) => c.name).sort();
      const drizzleCols = [...cols].sort();
      expect(sqlCols, name).toEqual(drizzleCols);
    }
  });

  it("enforces foreign keys", () => {
    const st = mem();
    expect(() => repo.insertPlan(st, basePlan({ userId: "nobody", guardianId: null }))).toThrow();
  });
});

describe("store: single-instance lock (spec 8.1)", () => {
  it("refuses to start while another holder's heartbeat is live", () => {
    const st = mem();
    acquireLock(st.sqlite, "a", T0);
    expect(() => acquireLock(st.sqlite, "b", new Date(T0.getTime() + 10_000))).toThrow(LockHeldError);
  });

  it("takes over a stale lock (heartbeat older than 30 s)", () => {
    const st = mem();
    acquireLock(st.sqlite, "a", T0);
    acquireLock(st.sqlite, "b", new Date(T0.getTime() + LOCK_STALE_MS + 1));
    expect(heartbeatLock(st.sqlite, "a", T0)).toBe(false);
    expect(heartbeatLock(st.sqlite, "b", T0)).toBe(true);
  });

  it("heartbeat keeps the lock live and release frees it", () => {
    const st = mem();
    acquireLock(st.sqlite, "a", T0);
    expect(heartbeatLock(st.sqlite, "a", new Date(T0.getTime() + 25_000))).toBe(true);
    expect(() => acquireLock(st.sqlite, "b", new Date(T0.getTime() + 50_000))).toThrow(LockHeldError);
    releaseLock(st.sqlite, "a");
    acquireLock(st.sqlite, "b", new Date(T0.getTime() + 50_000));
  });

  it("the same holder can re-acquire", () => {
    const st = mem();
    acquireLock(st.sqlite, "a", T0);
    acquireLock(st.sqlite, "a", T0);
  });
});

describe("store: users, guardians, links", () => {
  it("round-trips users and finds by address", () => {
    const st = mem();
    const u = repo.createUser(st, { addressE164: "+13125550100", now: T0 });
    expect(repo.getUserByAddress(st, "+13125550100")?.id).toBe(u.id);
    expect(u.decoyCaller).toBe("roommate");
    const u2 = repo.updateUser(st, u.id, { displayName: "Alex", decoyCaller: "mom", homeLat: 41.9, homeLng: -87.6 });
    expect(u2).toMatchObject({ displayName: "Alex", decoyCaller: "mom", homeLat: 41.9 });
  });

  it("stores code words hashed plus normalized, never raw", () => {
    const st = mem();
    const u = repo.createUser(st, { addressE164: "+13125550100", now: T0 });
    repo.setCodeWords(st, u.id, "  Pineapple! ", "Blue   MOON");
    expect(repo.getCodeWords(st, u.id)).toEqual({ exit: "pineapple", alert: "blue moon" });
    const row = st.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(u.id) as Record<string, unknown>;
    expect(row.exit_phrase_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("Pineapple");
    expect(repo.codeWordHashMatches(st, u.id, "BLUE moon.")).toBe("alert");
    expect(repo.codeWordHashMatches(st, u.id, "pineapple")).toBe("exit");
    expect(repo.codeWordHashMatches(st, u.id, "banana")).toBeNull();
  });

  it("upserts guardians and tracks link status", () => {
    const st = mem();
    const u = repo.createUser(st, { addressE164: "+13125550100", now: T0 });
    const g = repo.upsertGuardian(st, { addressE164: "+19195550142", displayName: "Priya", now: T0 });
    expect(repo.upsertGuardian(st, { addressE164: "+19195550142", now: T0 }).id).toBe(g.id);
    repo.setGuardianLink(st, { userId: u.id, guardianId: g.id, status: "pending", now: T0 });
    expect(repo.getAcceptedGuardian(st, u.id)).toBeNull();
    repo.setGuardianLink(st, { userId: u.id, guardianId: g.id, status: "accepted", now: at(5) });
    expect(repo.getAcceptedGuardian(st, u.id)?.id).toBe(g.id);
    repo.markGuardianStopped(st, g.id, at(10));
    expect(repo.getGuardianLink(st, u.id, g.id)?.status).toBe("revoked");
    expect(repo.getGuardian(st, g.id)?.stoppedAt?.getTime()).toBe(at(10).getTime());
  });
});

describe("store: plans", () => {
  it("round-trips every EnginePlan field", () => {
    const st = mem();
    const { plan } = seed(st);
    const updated = {
      ...plan,
      state: "CHECKING" as const,
      ladderStep: "L1" as const,
      ladderClass: "soft" as const,
      ladderTrigger: "T-DEP-WALK" as const,
      ladderStartedAt: at(30),
      ladderStepAt: at(35),
      escalationReason: { kind: "no_reply" as const, trigger: "T-DARK" as const, minutesSilent: 7 },
      suppressedUntil: { "T-DARK": at(50).toISOString() },
      lastCheckinMessageId: "msg-9",
      lastCheckinAt: at(35),
      guardianRepeatCount: 2,
      totalExtensionMin: 60,
      pendingSpot: { lat: 41.92, lng: -87.7, askedAt: at(40).toISOString() },
      flags: { ...plan.flags, clarifySent: true },
      updatedAt: at(35),
    };
    repo.savePlan(st, updated);
    expect(repo.getPlan(st, plan.id)).toEqual(updated);
  });

  it("finds the open plan for a user and ignores terminal ones", () => {
    const st = mem();
    const { plan, user } = seed(st);
    expect(repo.getOpenPlanForUser(st, user.id)?.id).toBe(plan.id);
    repo.savePlan(st, { ...plan, state: "CLOSED", closedAt: at(200) });
    expect(repo.getOpenPlanForUser(st, user.id)).toBeNull();
  });
});

describe("store: fixes and purge (I12)", () => {
  it("lists fixes ascending and purges fixes plus audit coordinates", () => {
    const st = mem();
    const { plan } = seed(st);
    repo.insertFix(st, plan.id, fixAt(at(2), 41.9, -87.7), at(2));
    repo.insertFix(st, plan.id, fixAt(at(1), 41.91, -87.71), at(1));
    expect(repo.listFixes(st, plan.id).map((f) => f.at.getTime())).toEqual([at(1).getTime(), at(2).getTime()]);
    expect(repo.listFixes(st, plan.id, { since: at(2) })).toHaveLength(1);
    repo.addPlanEvent(st, plan.id, "escalated", { reason: "no_reply", lastFix: { lat: 41.9, lng: -87.7, accuracyM: 20 }, url: "https://maps.apple.com/?ll=41.9,-87.7" }, at(3));
    repo.addPlanEvent(st, plan.id, "state", { from: "ACTIVE", to: "CLOSED" }, at(4));
    repo.savePlan(st, { ...plan, state: "CLOSED", closedAt: at(5), lastGuardianUpdateLat: 41.9, lastGuardianUpdateLng: -87.7 });
    expect(repo.listPlansNeedingPurge(st, at(5 + 24 * 60 - 1))).toEqual([]);
    expect(repo.listPlansNeedingPurge(st, at(5 + 24 * 60))).toEqual([plan.id]);

    const r = repo.purgePlanLocation(st, plan.id);
    expect(r).toEqual({ fixesDeleted: 2, eventsStripped: 1 });
    expect(repo.listFixes(st, plan.id)).toEqual([]);
    const events = repo.listPlanEvents(st, plan.id);
    expect(JSON.stringify(events)).not.toMatch(/41\.9|87\.7/);
    expect(events[0]!.data).toMatchObject({ reason: "no_reply", lastFix: { accuracyM: 20 } });
    expect(repo.getPlan(st, plan.id)?.lastGuardianUpdateLat).toBeNull();
  });

  it("stripCoordinates drops coordinate keys recursively", () => {
    expect(repo.stripCoordinates({ a: 1, lat: 2, venueLng: 3, nested: [{ latitude: 1, ok: true }] })).toEqual({ a: 1, nested: [{ ok: true }] });
  });
});

describe("store: dedupe, counters, messages, delete", () => {
  it("dedupes inbound ids and prunes after 7 days", () => {
    const st = mem();
    expect(repo.markInboundProcessed(st, "m1", T0)).toBe(true);
    expect(repo.markInboundProcessed(st, "m1", T0)).toBe(false);
    expect(repo.pruneProcessedInbound(st, at(7 * 24 * 60 + 1))).toBe(1);
  });

  it("counts per day and key", () => {
    const st = mem();
    expect(repo.incrementCounter(st, "2026-10-10", "sent")).toBe(1);
    expect(repo.incrementCounter(st, "2026-10-10", "sent", 4)).toBe(5);
    expect(repo.getCounter(st, "2026-10-11", "sent")).toBe(0);
  });

  it("deleteUserData removes user, plans, fixes, links, and messages", () => {
    const st = mem();
    const { user, plan, g } = seed(st);
    repo.insertFix(st, plan.id, fixAt(at(1), 41.9, -87.7), at(1));
    repo.recordMessage(st, { platformMessageId: "x", direction: "inbound", addressE164: user.addressE164, planId: plan.id, kind: "text", bodyRedacted: "hi", sentAt: T0 });
    repo.deleteUserData(st, user.id);
    expect(repo.getUser(st, user.id)).toBeNull();
    expect(repo.getPlan(st, plan.id)).toBeNull();
    expect(repo.getGuardianLink(st, user.id, g.id)).toBeNull();
    expect(st.sqlite.prepare("SELECT COUNT(*) AS n FROM location_fixes").get()).toEqual({ n: 0 });
    expect(st.sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(repo.getGuardian(st, g.id)).not.toBeNull();
  });
});
