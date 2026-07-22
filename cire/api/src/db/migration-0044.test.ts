import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 0044 replaces the eight per-section theme colours with the five-seed colour
// scheme, and BACK-FILLS the two that map cleanly onto the new roles. Every
// other migration test here covers structure; this one has to cover DATA,
// because it runs against live weddings whose organisers already picked
// colours — a silently-wrong back-fill would change what real guests see.
//
// Applies the chain in two halves (everything before 0044, seed rows, then
// 0044) so the "before" state is the real pre-migration schema, exactly as
// `wrangler d1 migrations apply` sees it.

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");
const TARGET = "0044_invite_palette.sql";

const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();

/** Apply every migration up to (but not including) 0044. */
function applyUpToTarget(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles()) {
    if (file === TARGET) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

/** Apply 0044 statement-by-statement, as `wrangler d1 migrations apply` does. */
function applyTarget(db: Database): void {
  const sql = readFileSync(join(MIGRATIONS_DIR, TARGET), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) db.exec(trimmed);
  }
}

function seedWedding(db: Database, id: string): void {
  db.exec(
    "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
      ` VALUES ('${id}', '${id}', 'W', 'usr_o', 0, 0);`,
  );
}

describe("0044 invite palette", () => {
  it("back-fills the hero accent + surface onto the gilt and card seeds", () => {
    const db = applyUpToTarget();
    seedWedding(db, "wed_a");
    db.exec(
      "INSERT INTO wedding_invite_customisations" +
        " (wedding_id, hero_accent_color, hero_surface_color, theme_heading_font, updated_at)" +
        " VALUES ('wed_a', '#d4af37', 'oklch(22.7% 0.0275 152.78)', 'cormorant', 0);",
    );

    applyTarget(db);

    const row = db
      .query(
        "SELECT palette_gilt, palette_card, palette_ground, theme_heading_font, story_tone" +
          " FROM wedding_invite_customisations WHERE wedding_id = 'wed_a'",
      )
      .get() as Record<string, string | null>;

    expect(row.palette_gilt).toBe("#d4af37");
    expect(row.palette_card).toBe("oklch(22.7% 0.0275 152.78)");
    // Roles with no sensible source stay NULL — they resolve to the default
    // preset's value at read time, i.e. today's look.
    expect(row.palette_ground).toBeNull();
    // Fonts are untouched by this migration.
    expect(row.theme_heading_font).toBe("cormorant");
  });

  it("preserves the story section's surface as a tone, not a flattened page", () => {
    // The story section has always painted `bg-surface`. Dropping the colour
    // columns without recording that would silently flatten every existing
    // invite's story band onto the page background.
    const db = applyUpToTarget();
    seedWedding(db, "wed_b");
    db.exec(
      "INSERT INTO wedding_invite_customisations (wedding_id, updated_at) VALUES ('wed_b', 0);",
    );

    applyTarget(db);

    const row = db
      .query(
        "SELECT story_tone, hero_tone, details_tone, welcome_tone" +
          " FROM wedding_invite_customisations WHERE wedding_id = 'wed_b'",
      )
      .get() as Record<string, string | null>;

    expect(row.story_tone).toBe("card");
    expect(row.hero_tone).toBeNull();
    expect(row.details_tone).toBeNull();
    expect(row.welcome_tone).toBeNull();
  });

  it("leaves a never-themed row entirely on the defaults", () => {
    const db = applyUpToTarget();
    seedWedding(db, "wed_c");
    db.exec(
      "INSERT INTO wedding_invite_customisations (wedding_id, hero_title, updated_at)" +
        " VALUES ('wed_c', 'Anita & Ben', 0);",
    );

    applyTarget(db);

    const row = db
      .query(
        "SELECT hero_title, palette_preset, palette_gilt, palette_card" +
          " FROM wedding_invite_customisations WHERE wedding_id = 'wed_c'",
      )
      .get() as Record<string, string | null>;

    expect(row.hero_title).toBe("Anita & Ben");
    expect(row.palette_preset).toBeNull();
    expect(row.palette_gilt).toBeNull();
    expect(row.palette_card).toBeNull();
  });

  it("preserves a details/welcome surface pick as a card tone", () => {
    // The branch that does the preserving. Without it, an invite whose organiser
    // picked a background for those sections silently flattens onto the page.
    const db = applyUpToTarget();
    seedWedding(db, "wed_d");
    db.exec(
      "INSERT INTO wedding_invite_customisations" +
        " (wedding_id, details_surface_color, welcome_surface_color, updated_at)" +
        " VALUES ('wed_d', '#333F27', '#6E735D', 0);",
    );

    applyTarget(db);

    const row = db
      .query(
        "SELECT hero_tone, story_tone, details_tone, welcome_tone" +
          " FROM wedding_invite_customisations WHERE wedding_id = 'wed_d'",
      )
      .get() as Record<string, string | null>;

    expect(row.details_tone).toBe("card");
    expect(row.welcome_tone).toBe("card");
    // The hero is exempt ON PURPOSE: its "surface" was the title panel behind
    // the text, not a section background, so giving it a tone would paint a
    // backdrop it never had. Pinned so a later reader doesn't "fix" it.
    expect(row.hero_tone).toBeNull();
  });

  it("leaves the hero untoned even when it had a surface colour", () => {
    const db = applyUpToTarget();
    seedWedding(db, "wed_e");
    db.exec(
      "INSERT INTO wedding_invite_customisations (wedding_id, hero_surface_color, updated_at)" +
        " VALUES ('wed_e', '#333F27', 0);",
    );

    applyTarget(db);

    const row = db
      .query(
        "SELECT hero_tone, palette_card FROM wedding_invite_customisations WHERE wedding_id = 'wed_e'",
      )
      .get() as Record<string, string | null>;

    expect(row.hero_tone).toBeNull();
    // It is carried as the card seed instead — consumed by --invite-panel.
    expect(row.palette_card).toBe("#333F27");
  });

  it("back-fills each row independently when several are migrated together", () => {
    // Every other fixture here migrates ONE row, so a WHERE that accidentally
    // matched every row would pass. Three rows in different states at once.
    const db = applyUpToTarget();
    for (const id of ["wed_f", "wed_g", "wed_h"]) seedWedding(db, id);
    db.exec(
      "INSERT INTO wedding_invite_customisations" +
        " (wedding_id, hero_accent_color, details_surface_color, updated_at) VALUES" +
        " ('wed_f', '#E5EAEF', '#333F27', 0)," +
        " ('wed_g', NULL, NULL, 0)," +
        " ('wed_h', '#AABBCC', NULL, 0);",
    );

    applyTarget(db);

    const rows = db
      .query(
        "SELECT wedding_id, palette_gilt, details_tone, story_tone" +
          " FROM wedding_invite_customisations ORDER BY wedding_id",
      )
      .all() as Record<string, string | null>[];

    expect(rows.map((r) => [r.wedding_id, r.palette_gilt, r.details_tone])).toEqual([
      ["wed_f", "#E5EAEF", "card"],
      ["wed_g", null, null],
      ["wed_h", "#AABBCC", null],
    ]);
    // The story band's tone is unconditional, so every row gets it.
    expect(rows.every((r) => r.story_tone === "card")).toBe(true);
  });

  it("back-fills the two hero columns independently", () => {
    const db = applyUpToTarget();
    seedWedding(db, "wed_i");
    db.exec(
      "INSERT INTO wedding_invite_customisations (wedding_id, hero_surface_color, updated_at)" +
        " VALUES ('wed_i', '#333F27', 0);",
    );

    applyTarget(db);

    const row = db
      .query(
        "SELECT palette_gilt, palette_card FROM wedding_invite_customisations WHERE wedding_id = 'wed_i'",
      )
      .get() as Record<string, string | null>;

    expect(row.palette_card).toBe("#333F27");
    expect(row.palette_gilt).toBeNull();
  });

  it("drops the divergent per-section accents rather than smuggling them into a seed", () => {
    // The documented, INTENDED data loss. Pinning it is what distinguishes a
    // deliberate product change from an accident nobody noticed.
    const db = applyUpToTarget();
    seedWedding(db, "wed_j");
    db.exec(
      "INSERT INTO wedding_invite_customisations" +
        " (wedding_id, hero_accent_color, story_accent_color, details_accent_color, updated_at)" +
        " VALUES ('wed_j', '#111111', '#222222', '#333333', 0);",
    );

    applyTarget(db);

    const row = db
      .query(
        "SELECT palette_gilt, palette_ground, palette_ink, palette_card, palette_bloom" +
          " FROM wedding_invite_customisations WHERE wedding_id = 'wed_j'",
      )
      .get() as Record<string, string | null>;

    // Only the hero accent survives, as the one accent the scheme now has.
    expect(row.palette_gilt).toBe("#111111");
    for (const seed of ["palette_ground", "palette_ink", "palette_card", "palette_bloom"]) {
      expect(row[seed], seed).toBeNull();
    }
  });

  it("drops every per-section colour column and adds the scheme columns", () => {
    const db = applyUpToTarget();
    applyTarget(db);

    const columns = (
      db.query("PRAGMA table_info(wedding_invite_customisations)").all() as { name: string }[]
    ).map((c) => c.name);

    for (const dropped of [
      "hero_accent_color",
      "hero_surface_color",
      "story_accent_color",
      "story_surface_color",
      "details_accent_color",
      "details_surface_color",
      "welcome_accent_color",
      "welcome_surface_color",
    ]) {
      expect(columns, `${dropped} must be dropped`).not.toContain(dropped);
    }
    for (const added of [
      "palette_preset",
      "palette_ground",
      "palette_card",
      "palette_ink",
      "palette_gilt",
      "palette_bloom",
      "hero_tone",
      "story_tone",
      "details_tone",
      "welcome_tone",
    ]) {
      expect(columns, `${added} must exist`).toContain(added);
    }
    // The copy + image + slider columns must survive untouched.
    for (const kept of ["hero_title", "story_body", "hero_image_key", "hero_blur"]) {
      expect(columns, `${kept} must survive`).toContain(kept);
    }
  });
});
