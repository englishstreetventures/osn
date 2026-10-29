import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PLANS } from "../../src/lib/plans";

/**
 * The plans the pricing section publishes against the tiers cire-api enforces.
 *
 * The API's `tiers.ts` imports drizzle, which this site does not depend on, so
 * the test reads it as text. A parse that finds nothing has to fail rather
 * than compare against an empty list, or a rename in the API would pass here
 * with every check skipped.
 */

const TIERS_SOURCE = readFileSync(
  join(import.meta.dirname, "../../../api/src/services/tiers.ts"),
  "utf8",
);

/** The tier ids `TIERS` lists, in order. Throws when the declaration is gone. */
function readTiers(source: string): string[] {
  const body = source.match(/export const TIERS = \[([^\]]*)\] as const;/)?.[1];
  const ids = [...(body ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
  if (ids.length === 0) throw new Error("tiers.ts no longer declares `export const TIERS = [...]`");
  return ids;
}

/** Each tier's guest cap from `TIER_GUEST_CAP`. Throws when the declaration is gone. */
function readGuestCaps(source: string): Map<string, number> {
  const body = source.match(/export const TIER_GUEST_CAP = \{([^}]*)\}/)?.[1];
  const caps = new Map(
    [...(body ?? "").matchAll(/(\w+):\s*([\d_]+)/g)].map((m) => [
      m[1]!,
      Number(m[2]!.replaceAll("_", "")),
    ]),
  );
  if (caps.size === 0) {
    throw new Error("tiers.ts no longer declares `export const TIER_GUEST_CAP = {...}`");
  }
  return caps;
}

describe("the published plans", () => {
  it("advertise each tier's guest cap as cire-api enforces it", () => {
    const caps = readGuestCaps(TIERS_SOURCE);
    expect(PLANS.map((plan) => [plan.id, plan.guestCap])).toEqual(
      PLANS.map((plan) => [plan.id, caps.get(plan.id)]),
    );
  });

  it("list every tier cire-api has, in its order", () => {
    expect(PLANS.map((plan) => plan.id)).toEqual(readTiers(TIERS_SOURCE));
  });

  it("refuse to compare against a tiers.ts that no longer declares either list", () => {
    expect(() => readTiers("export const TIER_LIST = ['ivory'];")).toThrow(/TIERS/);
    expect(() => readGuestCaps("export const GUEST_CAPS = { ivory: 100 };")).toThrow(
      /TIER_GUEST_CAP/,
    );
  });
});
