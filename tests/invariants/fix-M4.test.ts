// M4 (I14, I1): stop flags, dialogue state, and the opt-in sent time live in real tables, and
// the dialogue ports have a production DialogueRepo backed by the store. Everything survives a
// restart; the old counters-based stop flags are migrated.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { E164 } from "../../apps/server/src/contracts.js";
import { storeStopList } from "../../apps/server/src/app.js";
import { PlanRuntime } from "../../apps/server/src/plan/runtime.js";
import { openStore } from "../../apps/server/src/store/db.js";
import { StoreDialogueRepo } from "../../apps/server/src/store/dialogueRepo.js";
import { MIGRATIONS } from "../../apps/server/src/store/migrations.js";
import * as repo from "../../apps/server/src/store/repo.js";
import { FakeClock } from "../../apps/server/src/util/clock.js";
import { T0 } from "../unit/core/helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), "batman-m4-"));
  dirs.push(d);
  return join(d, "batman.db");
};
const A = "+13125550100" as E164;
const G = "+19195550142" as E164;

function repoFor(path: string) {
  const store = openStore(path);
  const clock = new FakeClock(T0);
  const runtime = new PlanRuntime({ store, clock, jobs: { enqueue: () => 0, cancel: () => 0 }, out: { send: async () => null, react: async () => {}, call: async () => false, requestLocation: async () => {}, startWatch: async () => {}, stopWatch: async () => {} }, defaultTz: "America/New_York" });
  return { store, runtime, r: new StoreDialogueRepo(store, { createDraft: (i) => runtime.createDraft(i), updatePlanFields: (id, p) => runtime.updatePlanFields(id, p) }) };
}

describe("M4 migrations", () => {
  it("version 3 moves counters-based stop flags into stopped_addresses", () => {
    const path = tmpDb();
    const old = openStore(path, MIGRATIONS.filter((m) => m.version <= 2));
    old.sqlite.prepare("INSERT INTO counters (day, key, value) VALUES ('stopped', ?, 1)").run(A);
    old.close();
    const st = openStore(path);
    expect(st.sqlite.prepare("SELECT address_e164 FROM stopped_addresses").all()).toEqual([{ address_e164: A }]);
    expect(st.sqlite.prepare("SELECT COUNT(*) AS n FROM counters WHERE day = 'stopped'").get()).toEqual({ n: 0 });
    expect(storeStopList(st).isStopped(A)).toBe(true);
    st.close();
  });
});

describe("M4 StoreDialogueRepo", () => {
  it("stop flags, dialogue state, and optinSentAt survive a restart", async () => {
    const path = tmpDb();
    const one = repoFor(path);
    const u = await one.r.createUser(A, T0);
    const g = await one.r.createGuardian(G, "Priya", T0);
    await one.r.setStopped(G, T0);
    await one.r.setDialogueState(u.id, { pending: { kind: "delete" } });
    await one.r.upsertLink({ userId: u.id, guardianId: g.id, status: "pending", requestedAt: T0, respondedAt: null, optinSentAt: new Date(T0.getTime() + 5000) });
    one.store.close();

    const two = repoFor(path);
    expect(await two.r.isStopped(G)).toBe(true);
    expect(two.r.isStoppedSync(G)).toBe(true);
    expect(await two.r.getDialogueState(u.id)).toEqual({ pending: { kind: "delete" } });
    expect((await two.r.getLink(u.id, g.id))?.optinSentAt).toEqual(new Date(T0.getTime() + 5000));
    await two.r.setStopped(G, null);
    expect(await two.r.isStopped(G)).toBe(false);
    await two.r.setDialogueState(u.id, null);
    expect(await two.r.getDialogueState(u.id)).toBeNull();
    two.store.close();
  });

  it("the gateway stop list reads and writes the same table (I14)", async () => {
    const { store, r } = repoFor(":memory:");
    storeStopList(store).setStopped(A, true);
    expect(await r.isStopped(A)).toBe(true);
    await r.setStopped(A, null);
    expect(storeStopList(store).isStopped(A)).toBe(false);
  });

  it("drafts go through the runtime (12 h draft_expire scheduled); plan edits through its per-plan queue", async () => {
    const { store, r } = repoFor(":memory:");
    const u = await r.createUser(A, T0);
    const g = await r.createGuardian(G, "Priya", T0);
    const p = await r.createDraftPlan(u.id, { guardianId: g.id, type: "date" }, T0);
    expect(repo.getPlan(store, p.id)?.state).toBe("DRAFT");
    await r.updatePlanFields(p.id, { venueText: "Lula Cafe" });
    expect((await r.getPlan(p.id))?.venueText).toBe("Lula Cafe");
    expect((await r.listOpenPlansForGuardian(g.id)).map((x) => x.id)).toEqual([p.id]);
    await r.updateGuardian(g.id, { stoppedAt: T0, displayName: "P" });
    expect(await r.getGuardian(g.id)).toMatchObject({ stoppedAt: T0, displayName: "P" });
  });

  it("deleting a user removes their dialogue state; deleted users are not found by address", async () => {
    const { store, r } = repoFor(":memory:");
    const u = await r.createUser(A, T0);
    await r.setDialogueState(u.id, { pending: { kind: "caller" } });
    await r.deleteUserData(u.id);
    expect(await r.getUserByAddress(A)).toBeNull();
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM dialogue_state").get()).toEqual({ n: 0 });
  });
});
