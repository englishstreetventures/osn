import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Data proof for migration 0073, which moves every wedding onto a plan tier.
//
// The backfill reads each wedding's legacy `wedding_entitlements` rows: `vendors`
// or `capacity_1000` lift it to Crimson, `registry` or `capacity_500` to Gold,
// and anything else leaves it on Ivory. The pending-purchase index narrows from
// (wedding, entitlement) to (wedding), so a wedding holding two pending
// per-module attempts must still migrate — which only works because the
// expire sits between dropping the old index and creating the new one.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const MIG_0073 = "0073_wedding_tiers.sql";

const numberOf = (file: string): number => Number(file.slice(0, 4));

/** The live chain's files numbered in [from, to), in the order wrangler runs them. */
function chain(from: number, to: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()
    .filter((f) => numberOf(f) >= from && numberOf(f) < to);
}

function apply(db: Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

// Each wedding's legacy entitlement rows, and the tier 0073 must give it.
const FIXTURES: Record<string, { keys: string[]; tier: "ivory" | "gold" | "crimson" }> = {
  wed_none: { keys: [], tier: "ivory" },
  wed_templates: { keys: ["premium_templates"], tier: "ivory" },
  wed_ai: { keys: ["ai"], tier: "ivory" },
  wed_registry: { keys: ["registry"], tier: "gold" },
  wed_cap500: { keys: ["capacity_500"], tier: "gold" },
  wed_vendors: { keys: ["vendors"], tier: "crimson" },
  wed_cap1000: { keys: ["capacity_1000"], tier: "crimson" },
  wed_both: { keys: ["registry", "vendors", "capacity_500"], tier: "crimson" },
  wed_everything: {
    keys: ["premium_templates", "vendors", "ai", "capacity_500", "capacity_1000", "registry"],
    tier: "crimson",
  },
};

const PURCHASE_STAMP = 1_790_000_000;

/** The database as 0073 finds it: every earlier migration, then the fixtures. */
function beforeMigration(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of chain(1, 73)) apply(db, file);
  for (const [weddingId, { keys }] of Object.entries(FIXTURES)) {
    db.query(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES (?, ?, ?, 'usr_owner', 0, 0)",
    ).run(weddingId, weddingId, weddingId);
    for (const key of keys) {
      db.query(
        "INSERT INTO wedding_entitlements (wedding_id, entitlement, source, granted_at, granted_by)" +
          " VALUES (?, ?, 'comp', 0, 'op')",
      ).run(weddingId, key);
    }
  }
  // Two per-module attempts in flight on one wedding — legal under the old
  // (wedding, entitlement) index, a violation of the new (wedding) one — and a
  // settled purchase on another, which nothing may touch.
  const purchase = db.query(
    "INSERT INTO wedding_upgrade_purchases" +
      " (id, wedding_id, entitlement, status, checkout_session_id, created_by_osn_profile_id, created_at, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, 'usr_owner', ?, ?)",
  );
  purchase.run("upg_v", "wed_none", "vendors", "pending", "cs_v", PURCHASE_STAMP, PURCHASE_STAMP);
  purchase.run("upg_r", "wed_none", "registry", "pending", null, PURCHASE_STAMP, PURCHASE_STAMP);
  purchase.run(
    "upg_done",
    "wed_registry",
    "registry",
    "succeeded",
    "cs_done",
    PURCHASE_STAMP,
    PURCHASE_STAMP,
  );
  return db;
}

type Tiered = { tier: string; tier_source: string | null; tier_granted_by: string | null };

function tierOf(db: Database, weddingId: string): Tiered {
  return db
    .query("SELECT tier, tier_source, tier_granted_by FROM weddings WHERE id = ?")
    .get(weddingId) as Tiered;
}

type PurchaseRow = { id: string; status: string; updated_at: number; from_tier: string | null };

function purchases(db: Database): PurchaseRow[] {
  return db
    .query("SELECT id, status, updated_at, from_tier FROM wedding_upgrade_purchases ORDER BY id")
    .all() as PurchaseRow[];
}

describe("migration 0073", () => {
  it("runs on a wedding holding two pending per-module purchases", () => {
    expect(chain(73, 74)).toEqual([MIG_0073]);
    const db = beforeMigration();
    expect(() => apply(db, MIG_0073)).not.toThrow();
    db.close();
  });

  it("lifts each wedding to the tier its legacy rows paid for", () => {
    const db = beforeMigration();
    apply(db, MIG_0073);
    for (const [weddingId, { keys, tier }] of Object.entries(FIXTURES)) {
      const lifted = tier !== "ivory";
      expect(tierOf(db, weddingId), `${weddingId} (${keys.join(",")})`).toEqual({
        tier,
        tier_source: lifted ? "migration" : null,
        tier_granted_by: null,
      });
    }
    db.close();
  });

  it("deletes no entitlement row", () => {
    const db = beforeMigration();
    const count = () =>
      (db.query("SELECT count(*) AS n FROM wedding_entitlements").get() as { n: number }).n;
    const before = count();
    apply(db, MIG_0073);
    expect(count()).toBe(before);
    expect(before).toBe(Object.values(FIXTURES).reduce((n, f) => n + f.keys.length, 0));
    db.close();
  });

  it("expires every pending purchase, stamps it, and leaves a settled one alone", () => {
    const db = beforeMigration();
    const startedAt = Math.floor(Date.now() / 1000);
    apply(db, MIG_0073);
    const rows = purchases(db);
    expect(rows.map(({ id, status, from_tier }) => ({ id, status, from_tier }))).toEqual([
      { id: "upg_done", status: "succeeded", from_tier: null },
      { id: "upg_r", status: "expired", from_tier: null },
      { id: "upg_v", status: "expired", from_tier: null },
    ]);
    const stamp = (id: string) => rows.find((r) => r.id === id)?.updated_at ?? 0;
    expect(stamp("upg_done")).toBe(PURCHASE_STAMP);
    expect(stamp("upg_r")).toBeGreaterThanOrEqual(startedAt);
    expect(stamp("upg_v")).toBeGreaterThanOrEqual(startedAt);
    db.close();
  });

  it("records no Price on any purchase written before it", () => {
    // A row with no recorded Price is settled only by the session it already
    // holds, so every pre-tier row must read NULL here rather than a default.
    const db = beforeMigration();
    apply(db, MIG_0073);
    expect(
      db
        .query(
          "SELECT id, price_id, price_amount_minor, price_currency FROM wedding_upgrade_purchases ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "upg_done", price_id: null, price_amount_minor: null, price_currency: null },
      { id: "upg_r", price_id: null, price_amount_minor: null, price_currency: null },
      { id: "upg_v", price_id: null, price_amount_minor: null, price_currency: null },
    ]);
    db.close();
  });

  it("allows one pending purchase per wedding, whatever it buys", () => {
    const db = beforeMigration();
    apply(db, MIG_0073);
    const insert = db.query(
      "INSERT INTO wedding_upgrade_purchases" +
        " (id, wedding_id, entitlement, status, from_tier, created_by_osn_profile_id, created_at, updated_at)" +
        " VALUES (?, ?, ?, 'pending', 'ivory', 'usr_owner', 0, 0)",
    );
    insert.run("upg_gold", "wed_none", "gold");
    expect(() => insert.run("upg_crimson", "wed_none", "crimson")).toThrow(
      /UNIQUE constraint failed: wedding_upgrade_purchases\.wedding_id$/,
    );
    // Another wedding is unaffected.
    expect(() => insert.run("upg_other", "wed_ai", "crimson")).not.toThrow();
    db.close();
  });

  it("starts a wedding created after it on Ivory", () => {
    const db = beforeMigration();
    apply(db, MIG_0073);
    db.query(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES ('wed_new', 'wed_new', 'New', 'usr_owner', 0, 0)",
    ).run();
    expect(tierOf(db, "wed_new")).toEqual({
      tier: "ivory",
      tier_source: null,
      tier_granted_by: null,
    });
    db.close();
  });
});
