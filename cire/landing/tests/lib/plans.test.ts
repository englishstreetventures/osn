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

  /** Every envelope needs Crimson (`PUT …/invite/envelope` refuses any other
   *  tier, `cire/api/src/routes/invite.ts`), and the terms send buyers here
   *  for what each plan includes. */
  /** A premium design needs Crimson too (`cire/api/src/routes/invite.ts`), so
   *  the day one joins the catalogue, Crimson's list has to say so. Read as
   *  text, like `tiers.ts`, and fail when the catalogue's shape is gone. */
  it("list premium designs among what Crimson adds whenever one exists", () => {
    const catalogue = readFileSync(
      join(import.meta.dirname, "../../../invite-designs/src/index.ts"),
      "utf8",
    );
    const tiers = [...catalogue.matchAll(/tier: "(free|premium)"/g)].map((m) => m[1]);
    if (tiers.length === 0) throw new Error("invite-designs no longer lists `tier:` per design");
    const crimson = PLANS.find((plan) => plan.id === "crimson");
    const mentionsDesigns = crimson?.inclusions.some((line) => /design/i.test(line)) ?? false;
    expect(mentionsDesigns).toBe(tiers.includes("premium"));
  });

  it("list the envelope among what Crimson adds", () => {
    const crimson = PLANS.find((plan) => plan.id === "crimson");
    expect(crimson?.inclusions.some((line) => /envelope/i.test(line))).toBe(true);
    for (const other of PLANS.filter((plan) => plan.id !== "crimson")) {
      expect(other.inclusions.some((line) => /envelope/i.test(line))).toBe(false);
    }
  });
});
