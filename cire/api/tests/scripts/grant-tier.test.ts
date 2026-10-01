import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildTierChange, tierChangeToSql } from "../../scripts/grant-tier";
import { DDL } from "../../src/db/setup";

/** A database with one wedding on `tier`, for running the printed SQL. */
function weddingOn(tier: string): Database {
  const db = new Database(":memory:");
  db.exec(DDL);
  db.query(
    "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, tier, created_at, updated_at)" +
      " VALUES ('wed_a', 'a', 'A', 'usr_owner', ?, 0, 0)",
  ).run(tier);
  return db;
}

function tierOf(db: Database) {
  return db
    .query("SELECT tier, tier_source, tier_granted_by FROM weddings WHERE id = 'wed_a'")
    .get();
}

describe("buildTierChange", () => {
  it("names the operator as a script grant", () => {
    expect(buildTierChange("wed_vr", "crimson", "ops_ana")).toEqual({
      weddingId: "wed_vr",
      tier: "crimson",
      grantedBy: "script:ops_ana",
      lower: false,
    });
  });

  it("rejects an unknown tier", () => {
    expect(() => buildTierChange("wed_vr", "platinum", "ops")).toThrow("unknown tier");
  });

  it("refuses ivory without --lower", () => {
    expect(() => buildTierChange("wed_vr", "ivory", "ops")).toThrow("--lower");
    expect(() => buildTierChange("wed_vr", "ivory", "ops", true)).not.toThrow();
  });

  // Validate operator-supplied CLI args before SQL interpolation.
  it("rejects a malicious weddingId containing SQL injection payload", () => {
    expect(() => buildTierChange("wed_'; DROP TABLE x;--", "gold", "ops")).toThrow(
      "invalid weddingId",
    );
  });
  it("rejects a weddingId that does not start with wed_", () => {
    expect(() => buildTierChange("evil_abc", "gold", "ops")).toThrow("invalid weddingId");
  });
  it("rejects a malicious operator containing SQL injection payload", () => {
    expect(() => buildTierChange("wed_abc", "gold", "usr'; DROP TABLE x;--")).toThrow(
      "invalid operator",
    );
  });
  it("rejects an operator with spaces or special characters", () => {
    expect(() => buildTierChange("wed_abc", "gold", "ops ana@example.com")).toThrow(
      "invalid operator",
    );
  });
  it("rejects a tier carrying a SQL payload", () => {
    expect(() => buildTierChange("wed_abc", "gold'; DROP TABLE x;--", "ops")).toThrow(
      "unknown tier",
    );
  });
});

describe("tierChangeToSql", () => {
  it("raises a wedding below the tier", () => {
    const db = weddingOn("ivory");
    db.exec(tierChangeToSql(buildTierChange("wed_a", "gold", "ops")));
    expect(tierOf(db)).toEqual({
      tier: "gold",
      tier_source: "comp",
      tier_granted_by: "script:ops",
    });
  });

  it("never lowers a wedding without --lower", () => {
    const db = weddingOn("crimson");
    db.exec(tierChangeToSql(buildTierChange("wed_a", "gold", "ops")));
    expect(tierOf(db)).toEqual({ tier: "crimson", tier_source: null, tier_granted_by: null });
  });

  it("leaves a wedding already on the tier untouched", () => {
    const db = weddingOn("gold");
    const sql = tierChangeToSql(buildTierChange("wed_a", "gold", "ops"));
    db.exec(sql);
    expect(tierOf(db)).toEqual({ tier: "gold", tier_source: null, tier_granted_by: null });
  });

  it("lowers a wedding with --lower, and records who did", () => {
    const db = weddingOn("crimson");
    db.exec(tierChangeToSql(buildTierChange("wed_a", "ivory", "ops", true)));
    expect(tierOf(db)).toEqual({
      tier: "ivory",
      tier_source: "comp",
      tier_granted_by: "script:ops",
    });
  });
});

/**
 * Lowering a wedding is how a refund takes back what was bought, so it must
 * also take back the purchase: a paid purchase still reading `succeeded`
 * would be granted again by the next delivery of its payment.
 */
describe("--lower and the wedding's purchases", () => {
  /** Purchases on `wed_a` (and one on another wedding), by id → [product, status]. */
  function withPurchases(tier: string): Database {
    const db = weddingOn(tier);
    db.query(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, tier, created_at, updated_at)" +
        " VALUES ('wed_b', 'b', 'B', 'usr_owner', 'crimson', 0, 0)",
    ).run();
    const insert = db.query(
      "INSERT INTO wedding_upgrade_purchases" +
        " (id, wedding_id, entitlement, status, created_by_osn_profile_id, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, 'usr_owner', 0, 0)",
    );
    insert.run("upg_gold", "wed_a", "gold", "succeeded");
    insert.run("upg_crimson", "wed_a", "crimson", "succeeded");
    insert.run("upg_vendors", "wed_a", "vendors", "succeeded");
    insert.run("upg_registry", "wed_a", "registry", "succeeded");
    insert.run("upg_templates", "wed_a", "premium_templates", "succeeded");
    insert.run("upg_open", "wed_a", "crimson", "pending");
    insert.run("upg_lapsed", "wed_a", "crimson", "expired");
    insert.run("upg_elsewhere", "wed_b", "crimson", "succeeded");
    return db;
  }

  const statuses = (db: Database) =>
    Object.fromEntries(
      (
        db.query("SELECT id, status FROM wedding_upgrade_purchases ORDER BY id").all() as {
          id: string;
          status: string;
        }[]
      ).map((r) => [r.id, r.status]),
    );

  it("to Gold, marks the paid purchases that bought more than Gold refunded, and only those", () => {
    const db = withPurchases("crimson");
    db.exec(tierChangeToSql(buildTierChange("wed_a", "gold", "ops", true)));
    expect(statuses(db)).toEqual({
      upg_crimson: "refunded",
      upg_elsewhere: "succeeded",
      upg_gold: "succeeded",
      upg_lapsed: "expired",
      upg_open: "pending",
      upg_registry: "succeeded",
      upg_templates: "succeeded",
      upg_vendors: "refunded",
    });
    expect(tierOf(db)).toMatchObject({ tier: "gold" });
  });

  it("to Ivory, marks every paid tier purchase refunded", () => {
    const db = withPurchases("crimson");
    db.exec(tierChangeToSql(buildTierChange("wed_a", "ivory", "ops", true)));
    expect(statuses(db)).toMatchObject({
      upg_gold: "refunded",
      upg_crimson: "refunded",
      upg_vendors: "refunded",
      upg_registry: "refunded",
      upg_templates: "succeeded",
      upg_elsewhere: "succeeded",
    });
  });

  it("marks the purchases before it moves the tier", () => {
    // A payment redelivered between the two statements must find the purchase
    // already refunded, never a lowered wedding beside a purchase that still
    // reads paid.
    const sql = tierChangeToSql(buildTierChange("wed_a", "ivory", "ops", true));
    const refund = sql.indexOf("UPDATE wedding_upgrade_purchases");
    const lower = sql.indexOf("UPDATE weddings");
    expect(refund).toBeGreaterThanOrEqual(0);
    expect(refund).toBeLessThan(lower);
  });

  it("refunds nothing when setting Crimson, the top tier", () => {
    const sql = tierChangeToSql(buildTierChange("wed_a", "crimson", "ops", true));
    expect(sql).not.toContain("wedding_upgrade_purchases");
  });

  it("refunds nothing without --lower", () => {
    const db = withPurchases("ivory");
    db.exec(tierChangeToSql(buildTierChange("wed_a", "gold", "ops")));
    expect(Object.values(statuses(db))).not.toContain("refunded");
  });
});
