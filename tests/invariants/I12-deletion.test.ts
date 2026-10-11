// I12. Deletion: raw location fixes are deleted 24 hours after a plan closes. Plan audit events
// keep only coarse data (no coordinates) after that.
import { afterEach, describe, expect, it } from "vitest";
import * as repo from "../../apps/server/src/store/repo.js";
import { DATE_EXTRACTION, FullStack } from "../sim/fullstack.js";

const sims: FullStack[] = [];
afterEach(() => sims.splice(0).forEach((s) => s.close()));

const COORD = /-?\d{1,3}\.\d{4,}/;

describe("I12 deletion", () => {
  it.each([
    ["closed by home after an escalation with guardian updates", [[140, "user", "blue moon"], [142, "guardian", "got it"], [175, "user", "home"]], 175],
    ["cancelled mid-date", [[60, "user", "cancel"]], 60],
  ] as const)("%s: fixes and coordinates are gone 24 h after the end, not before", async (_n, script, endMin) => {
    const s = new FullStack({ track: "date-overtime", trackMessages: false, llm: { extract: [{ match: "jordan", out: DATE_EXTRACTION }] } });
    sims.push(s);
    await s.onboard();
    await s.planDate();
    for (const [t, who, text] of script) s.at(t, who as "user" | "guardian", text);
    await s.runUntil(endMin + 1);
    const id = s.plan()!.id;
    expect(["CLOSED", "CANCELLED"]).toContain(s.plan()!.state);
    expect(repo.listFixes(s.store, id).length).toBeGreaterThan(0);
    await s.runUntil(endMin + 24 * 60 - 1);
    expect(repo.listFixes(s.store, id).length).toBeGreaterThan(0);
    await s.runUntil(endMin + 24 * 60 + 1);
    expect(repo.listFixes(s.store, id)).toEqual([]);
    for (const e of repo.listPlanEvents(s.store, id)) expect(JSON.stringify(e.data ?? {}), e.kind).not.toMatch(COORD);
    const p = repo.getPlan(s.store, id)!;
    expect([p.lastGuardianUpdateLat, p.lastGuardianUpdateLng]).toEqual([null, null]);
  });
});
