// Paid features granted to the sample wedding. Consumed only by
// cire/db/seed/generate.ts.
//
// All of them are `comp` (granted, not purchased) — the same way the live
// wedding holds them, and the only honest source on a tier with no payment
// provider wired up. Without them the dev wedding sits on the free tier and the
// premium surfaces (vendors, AI, the 1000-guest cap) are invisible, so nobody
// exercises them before a release reaches prod.
//
// `registry` is the odd one: the gift registry ships built but locked, held by
// no wedding in production. Comping it here and nowhere else is what makes it
// testable end to end while no real wedding can reach it.

export type SeedEntitlement = {
  readonly entitlement:
    | "premium_templates"
    | "vendors"
    | "ai"
    | "capacity_500"
    | "capacity_1000"
    | "registry";
  readonly source: "purchase" | "comp";
  readonly grantedBy: string;
};

export const entitlements = [
  { entitlement: "ai", source: "comp", grantedBy: "dev-seed" },
  { entitlement: "capacity_1000", source: "comp", grantedBy: "dev-seed" },
  { entitlement: "premium_templates", source: "comp", grantedBy: "dev-seed" },
  { entitlement: "registry", source: "comp", grantedBy: "dev-seed" },
  { entitlement: "vendors", source: "comp", grantedBy: "dev-seed" },
] as const satisfies readonly SeedEntitlement[];
