/**
 * Comp/manual entitlement grant CLI. The Phase-1 grant seam for V&R's full comp,
 * "contact us" capacity_1000, and support goodwill. NOT a network surface —
 * cire has no inbound ARC route; this runs as an operator tool.
 *
 * Local:  bun run cire/api/scripts/grant-entitlement.ts <weddingId> <key,key,...>
 * Prod:   apply the equivalent rows via `wrangler d1 execute cire-db --remote`
 *         using the SQL this prints (a prod D1 write — requires explicit human
 *         authorization naming cire-db before running).
 */
import { ENTITLEMENT_KEYS } from "../src/services/entitlements";
import type { EntitlementKey } from "../src/services/entitlements";

const WEDDING_ID_RE = /^wed_[A-Za-z0-9_]+$/;
const GRANTED_BY_RE = /^[A-Za-z0-9_]+$/;

export function buildGrants(weddingId: string, keys: EntitlementKey[], grantedBy: string) {
  if (!WEDDING_ID_RE.test(weddingId)) throw new Error("invalid weddingId");
  if (!GRANTED_BY_RE.test(grantedBy)) throw new Error("invalid grantedBy");
  for (const k of keys) {
    if (!ENTITLEMENT_KEYS.includes(k)) throw new Error(`unknown entitlement key: ${k}`);
  }
  return keys.map((key) => ({ key, opts: { source: "comp" as const, grantedBy } }));
}

/** Print the idempotent SQL for the requested comp grants (for wrangler d1 execute). */
export function grantsToSql(
  weddingId: string,
  keys: EntitlementKey[],
  grantedBy: string,
  nowMs: number,
) {
  return buildGrants(weddingId, keys, grantedBy)
    .map(
      (g) =>
        `INSERT OR IGNORE INTO wedding_entitlements (wedding_id, entitlement, source, granted_at, granted_by, provider_ref) ` +
        `VALUES ('${weddingId}', '${g.key}', 'comp', ${nowMs}, '${grantedBy}', NULL);`,
    )
    .join("\n");
}

// Thin main for local runs (bun:sqlite). Guarded so importing the module in
// tests does not execute it.
if (import.meta.main) {
  const [weddingId, keysCsv, grantedBy = "operator"] = Bun.argv.slice(2);
  if (!weddingId || !keysCsv) {
    console.error("usage: grant-entitlement.ts <weddingId> <key,key,...> [grantedBy]");
    process.exit(1);
  }
  const keys = keysCsv.split(",") as EntitlementKey[];
  // Print the prod SQL (the safe, reviewable artifact). Local application can be
  // wired against createDb by the operator if desired.
  console.log(grantsToSql(weddingId, keys, grantedBy, Date.now()));
}
