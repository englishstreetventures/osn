/**
 * Comp/manual plan-tier CLI: an operator moving a wedding to a tier without a
 * purchase — a comp, "contact us" capacity, support goodwill, or lowering a
 * wedding after a refund. NOT a network surface — cire has no inbound route for
 * this; it runs as an operator tool and prints SQL.
 *
 *   bun run cire/api/scripts/grant-tier.ts <weddingId> <gold|crimson> <operator>
 *   bun run cire/api/scripts/grant-tier.ts <weddingId> <ivory|gold|crimson> <operator> --lower
 *
 * Without `--lower` the statement only ever RAISES the tier, exactly as a
 * purchase does: a wedding already on that tier or above it is left untouched,
 * so the SQL is safe to run twice. `--lower` sets the tier outright, which is
 * how a refund takes a wedding back down — a deliberate act, never automatic.
 * Either way the row records `tier_source = 'comp'` and
 * `tier_granted_by = 'script:<operator>'`.
 *
 * Production: apply the printed SQL with `wrangler d1 execute cire-db --remote
 * --command "<sql>"` — a prod D1 write, which needs explicit human
 * authorisation naming `cire-db` first.
 */
import { isTier, tiersBelow } from "../src/services/tiers";
import type { Tier } from "../src/services/tiers";

const WEDDING_ID_RE = /^wed_[A-Za-z0-9_]+$/;
const OPERATOR_RE = /^[A-Za-z0-9_]+$/;

export interface TierChange {
  weddingId: string;
  tier: Tier;
  grantedBy: string;
  /** Set the tier outright rather than only raising it. */
  lower: boolean;
}

/**
 * Validate operator-supplied arguments before any of them reaches SQL. Every
 * value interpolated below has passed one of these checks, which is what makes
 * the string-built statement safe to print.
 */
export function buildTierChange(
  weddingId: string,
  tier: string,
  operator: string,
  lower = false,
): TierChange {
  if (!WEDDING_ID_RE.test(weddingId)) throw new Error("invalid weddingId");
  if (!OPERATOR_RE.test(operator)) throw new Error("invalid operator");
  if (!isTier(tier)) throw new Error(`unknown tier: ${tier}`);
  if (tier === "ivory" && !lower) {
    throw new Error("ivory is the lowest tier: moving a wedding to it needs --lower");
  }
  return { weddingId, tier, grantedBy: `script:${operator}`, lower };
}

/** The statement for a tier change, ready for `wrangler d1 execute`. */
export function tierChangeToSql(change: TierChange): string {
  const set =
    `UPDATE weddings SET tier = '${change.tier}', tier_source = 'comp', ` +
    `tier_granted_by = '${change.grantedBy}' WHERE id = '${change.weddingId}'`;
  if (change.lower) return `${set};`;
  const below = tiersBelow(change.tier)
    .map((t) => `'${t}'`)
    .join(", ");
  return `${set} AND tier IN (${below});`;
}

// Thin main. Guarded so importing the module in tests does not execute it.
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const lower = args.includes("--lower");
  const [weddingId, tier, operator] = args.filter((a) => a !== "--lower");
  if (!weddingId || !tier || !operator) {
    process.stderr.write(
      "usage: grant-tier.ts <weddingId> <ivory|gold|crimson> <operator> [--lower]\n",
    );
    process.exit(1);
  }
  // Print the SQL — the safe, reviewable artefact — rather than writing it.
  process.stdout.write(`${tierChangeToSql(buildTierChange(weddingId, tier, operator, lower))}\n`);
}
