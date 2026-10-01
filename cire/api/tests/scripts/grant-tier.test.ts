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
