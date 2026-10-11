// Build the EngineContext for a plan from the store (spec 6, 7).
import type { Store } from "../store/db.js";
import * as repo from "../store/repo.js";
import type { EngineContext, EnginePlan, GuardianCtx } from "./types.js";

/** How far back fixes are loaded for decisions (departure needs the inside history). */
export const CONTEXT_FIX_WINDOW_MS = 4 * 60 * 60_000;

export function buildContext(
  store: Store,
  plan: EnginePlan,
  now: Date,
  defaultTz: string,
  extra: Pick<EngineContext, "share" | "lastUserMessageId" | "night"> = {},
): EngineContext {
  const user = repo.getUser(store, plan.userId);
  let guardian: GuardianCtx | null = null;
  if (plan.guardianId) {
    const g = repo.getGuardian(store, plan.guardianId);
    const link = repo.getGuardianLink(store, plan.userId, plan.guardianId);
    // I14: a guardian is stopped by their record or by an address-level STOP (stopped_addresses).
    if (g && link) guardian = { displayName: g.displayName, linkStatus: link.status, stopped: g.stoppedAt !== null || repo.isStopped(store, g.addressE164) };
  }
  const ctx: EngineContext = {
    now,
    user: {
      displayName: user?.displayName ?? null,
      homeLat: user?.homeLat ?? null,
      homeLng: user?.homeLng ?? null,
      decoyCaller: user?.decoyCaller ?? "roommate",
      stopped: user ? repo.isStopped(store, user.addressE164) : false,
    },
    guardian,
    timeZone: user?.tz ?? defaultTz,
    fixes: repo.listFixes(store, plan.id, { since: new Date(now.getTime() - CONTEXT_FIX_WINDOW_MS) }),
  };
  if (extra.share !== undefined) ctx.share = extra.share;
  if (extra.lastUserMessageId !== undefined) ctx.lastUserMessageId = extra.lastUserMessageId;
  else if (user) ctx.lastUserMessageId = repo.lastInboundMessageId(store, user.addressE164); // X2: tapback target
  if (extra.night !== undefined) ctx.night = extra.night;
  return ctx;
}
