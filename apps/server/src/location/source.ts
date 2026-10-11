// Location source selection and the privacy guards every source must apply (spec 7.1, I2, I3).
// findmy.ts and pin.ts implement LocationSource elsewhere; this module wires them by kind.
import { WINDOW_STATES, type E164, type Fix, type LocationSource, type PlanState } from "../contracts.js";

export type { LocationSource };
export type LocationSourceKind = "findmy" | "pin" | "replay" | "none";

/**
 * I2: keep only entries whose address is exactly the plan user's address. Photon's list()
 * may return other friends visible to the line; those are dropped, never stored.
 */
export function filterByExactAddress<T>(
  entries: readonly T[],
  userAddress: E164,
  getAddress: (e: T) => string | null | undefined = (e) => (e as { address?: string | null }).address,
): T[] {
  return entries.filter((e) => {
    const a = getAddress(e);
    return typeof a === "string" && a === userAddress;
  });
}

/** I2 for a single entry. */
export function belongsToUser(entryAddress: string | null | undefined, userAddress: E164): boolean {
  return typeof entryAddress === "string" && entryAddress === userAddress;
}

/** I3: fixes are processed and stored only while the plan is in a window. */
export function acceptsFixInState(state: PlanState | null | undefined): boolean {
  return !!state && WINDOW_STATES.includes(state);
}

/** Time-only mode (no sharing). */
export class NoneLocationSource implements LocationSource {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

export interface LocationSourceFactories {
  findmy?: () => LocationSource;
  pin?: () => LocationSource;
  replay?: () => LocationSource;
}

/** Build the source for LOCATION_SOURCE. Missing implementations fail loudly except "none". */
export function createLocationSource(kind: LocationSourceKind, factories: LocationSourceFactories): LocationSource {
  if (kind === "none") return new NoneLocationSource();
  const f = factories[kind];
  if (!f) throw new Error(`LOCATION_SOURCE=${kind} has no implementation wired`);
  return f();
}

/**
 * Wrap a fix callback so it only forwards fixes for the expected user (I2) while their plan
 * is in a window (I3). `planState` is read at delivery time.
 */
export function guardedFixHandler(
  userAddress: E164,
  planState: () => PlanState | null,
  onFix: (fix: Fix) => void,
): (fix: Fix, fromAddress?: string | null) => boolean {
  return (fix, fromAddress) => {
    if (fromAddress !== undefined && !belongsToUser(fromAddress, userAddress)) return false;
    if (!acceptsFixInState(planState())) return false;
    onFix(fix);
    return true;
  };
}
