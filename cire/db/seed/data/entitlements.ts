// One-off capabilities granted to the sample wedding. Consumed only by
// cire/db/seed/generate.ts.
//
// The wedding's plan is its tier (`tier: "crimson"` in wedding.ts), which
// already includes premium templates. The row is comped anyway so the one
// remaining entitlement read — `premium_templates` on a wedding below Crimson —
// has a row to find when a tester lowers the tier by hand.

export type SeedEntitlement = {
  readonly entitlement: "premium_templates";
  readonly source: "purchase" | "comp";
  readonly grantedBy: string;
};

export const entitlements = [
  { entitlement: "premium_templates", source: "comp", grantedBy: "dev-seed" },
] as const satisfies readonly SeedEntitlement[];
