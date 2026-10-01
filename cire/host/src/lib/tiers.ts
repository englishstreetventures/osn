/**
 * The plan tiers, as the portal reads them.
 *
 * A wedding is on exactly one tier. The API decides what each tier opens — its
 * tier gate answers 402 for a module the wedding's tier does not include — and
 * the portal reads the same rule here only so that it never offers a module
 * the API would refuse. `cire/api/src/services/tiers.ts` is the authority; this
 * is its mirror, and the two lists must name the same tiers in the same order —
 * `tests/lib/tiers.contract.test.ts` reads both and fails when they differ.
 *
 * - `ivory` — free: the invite, the guest list, RSVPs and import.
 * - `gold` — adds the budget, the checklist and the gift registry.
 * - `crimson` — adds vendors (the CRM, the directory and enquiries) and every
 *   premium invite design.
 */

/** The tiers, lowest first. The order is the ranking. */
export const TIERS = ["ivory", "gold", "crimson"] as const;
export type Tier = (typeof TIERS)[number];

/** A tier above the free one — what can be bought. */
export type PaidTier = Exclude<Tier, "ivory">;

/** The name an organiser sees for each tier. */
export const TIER_LABEL = {
  ivory: "Ivory",
  gold: "Gold",
  crimson: "Crimson",
} as const satisfies Record<Tier, string>;

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function isPaidTier(value: unknown): value is PaidTier {
  return isTier(value) && value !== "ivory";
}

/** Whether a wedding on `held` has everything `min` includes. */
export function tierAtLeast(held: Tier, min: Tier): boolean {
  return TIERS.indexOf(held) >= TIERS.indexOf(min);
}

/**
 * The tier a wedding list from an API that predates tiers implies, read from
 * the legacy entitlement keys it still sends — the same mapping migration 0073
 * applied to the stored rows: `vendors` or `capacity_1000` is Crimson,
 * `registry` or `capacity_500` is Gold, anything else Ivory.
 */
// Removed by englishstventures/osn#1315, once every API this portal talks to sends `tier`.
export function legacyTierFromEntitlements(entitlements: readonly string[]): Tier {
  if (entitlements.includes("vendors") || entitlements.includes("capacity_1000")) {
    return "crimson";
  }
  if (entitlements.includes("registry") || entitlements.includes("capacity_500")) return "gold";
  return "ivory";
}

/**
 * A wedding's tier as the portal acts on it.
 *
 * The list endpoint's `tier` when it sent one. A value this build does not
 * recognise reads as `ivory`, the tier that opens nothing paid, so an unknown
 * string can never unlock a module. With no `tier` at all the list came from
 * an API that predates tiers, and its legacy keys say what the wedding holds.
 */
export function tierOf(wedding: { tier?: unknown; entitlements?: readonly string[] }): Tier {
  if (wedding.tier === undefined) return legacyTierFromEntitlements(wedding.entitlements ?? []);
  return isTier(wedding.tier) ? wedding.tier : "ivory";
}
