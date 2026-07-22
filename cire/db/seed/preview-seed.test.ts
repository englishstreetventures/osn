import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `preview-seed.sql` is hand-written (unlike `dev-seed.sql`, which is generated
 * and covered by `seed.test.ts`) and is coupled to migration 0044's column set.
 * Without this test a stale column name fails at PREVIEW-DEPLOY time, inside a
 * GitHub Actions job, rather than in CI.
 *
 * Applies the real migration chain, then the seed, exactly as the workflow does.
 */
const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const SEED = join(import.meta.dir, "preview-seed.sql");

function migratedDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function applySeed(db: Database): void {
  db.exec(readFileSync(SEED, "utf8"));
}

describe("preview-seed.sql", () => {
  it("applies cleanly against the full migration chain", () => {
    const db = migratedDb();
    expect(() => applySeed(db)).not.toThrow();

    const counts = db
      .query(
        "SELECT (SELECT COUNT(*) FROM weddings) w," +
          " (SELECT COUNT(*) FROM wedding_invite_customisations) c," +
          " (SELECT COUNT(*) FROM events) e," +
          " (SELECT COUNT(*) FROM families) f," +
          " (SELECT COUNT(*) FROM guests) g," +
          " (SELECT COUNT(*) FROM guest_events) ge",
      )
      .get() as Record<string, number>;

    expect(counts).toEqual({ w: 3, c: 3, e: 6, f: 3, g: 6, ge: 9 });
  });

  it("is idempotent — the workflow re-runs it on every push", () => {
    const db = migratedDb();
    applySeed(db);
    expect(() => applySeed(db)).not.toThrow();
    expect((db.query("SELECT COUNT(*) n FROM weddings").get() as { n: number }).n).toBe(3);
    expect((db.query("SELECT COUNT(*) n FROM events").get() as { n: number }).n).toBe(6);
  });

  it("gives each sample wedding its own scheme, with the built-in as the control", () => {
    const db = migratedDb();
    applySeed(db);
    const rows = db
      .query(
        "SELECT w.slug, c.palette_preset, c.details_tone FROM weddings w" +
          " JOIN wedding_invite_customisations c ON c.wedding_id = w.id ORDER BY w.slug",
      )
      .all() as Record<string, string | null>[];

    expect(rows).toEqual([
      { slug: "preview-chapel", palette_preset: "chapel", details_tone: "card" },
      // The control carries NO preset: it must render exactly as production does.
      { slug: "preview-evergreen", palette_preset: null, details_tone: "card" },
      { slug: "preview-jewel", palette_preset: "jewel", details_tone: "raised" },
    ]);
  });

  it("gives every sample ceremony a distinct slug", () => {
    // `events.slug` is UNIQUE across ALL weddings, so a shared "ceremony" slug
    // silently drops two of the three rows via OR IGNORE and their guest_events
    // then fail the foreign key. That is how this seed broke the first time.
    const db = migratedDb();
    applySeed(db);
    const slugs = (db.query("SELECT slug FROM events").all() as { slug: string }[]).map(
      (r) => r.slug,
    );
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.length).toBe(6);
  });
});
