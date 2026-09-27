import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Data proof for migration 0065, which switches the hero, Our Story and closing
// section on for every invite that already exists. 0063 filled those switches
// from each section's emptiness check, so a blank section arrives here switched
// off; an organiser may also have switched a filled one off since. Either way
// 0065 leaves all three on, and touches nothing else on the row.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const MIG_0065 = "0065_invite_sections_switched_on.sql";

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

/** Content columns that exist before 0063, so rows can be seeded ahead of its backfill. */
type Content = {
  hero_title?: string;
  hero_image_key?: string;
  story_body?: string;
  footer_message?: string;
};
const CONTENT_COLUMNS = ["hero_title", "hero_image_key", "story_body", "footer_message"] as const;

const FILLED: Content = {
  hero_title: "Anita & Ben",
  story_body: "We met on a train.",
  footer_message: "No boxed gifts please",
};

// Each wedding's content, and what 0063's backfill makes of it. The three
// `wed_no_*` rows each have exactly one section blank, so each term of 0065's
// WHERE is the only one that selects some row.
const FIXTURES: Record<string, Content> = {
  wed_blank: {},
  wed_mixed: { hero_image_key: "assets/w/hero-1" },
  wed_no_hero: { story_body: FILLED.story_body, footer_message: FILLED.footer_message },
  wed_no_story: { hero_title: FILLED.hero_title, footer_message: FILLED.footer_message },
  wed_no_closing: { hero_title: FILLED.hero_title, story_body: FILLED.story_body },
  wed_hidden: FILLED,
  wed_on: FILLED,
};

type Switches = { hero_visible: number; story_visible: number; footer_visible: number };
const ALL_ON: Switches = { hero_visible: 1, story_visible: 1, footer_visible: 1 };
const SWITCH_COLUMNS = new Set(["hero_visible", "story_visible", "footer_visible"]);

function switchesOf(db: Database, weddingId: string): Switches {
  return db
    .query(
      "SELECT hero_visible, story_visible, footer_visible FROM wedding_invite_customisations WHERE wedding_id = ?",
    )
    .get(weddingId) as Switches;
}

/** Every column of every row except the three switches 0065 sets. */
function everythingButTheSwitches(db: Database): Array<Record<string, unknown>> {
  const rows = db
    .query("SELECT * FROM wedding_invite_customisations ORDER BY wedding_id")
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([column]) => !SWITCH_COLUMNS.has(column))),
  );
}

const totalChanges = (db: Database): number =>
  (db.query("SELECT total_changes() AS n").get() as { n: number }).n;

/**
 * The database as 0065 finds it: the fixtures seeded before 0063, 0063's
 * backfill and 0064 applied, then an organiser's switch-offs on top.
 */
function beforeMigration(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of chain(1, 63)) apply(db, file);
  for (const [weddingId, content] of Object.entries(FIXTURES)) {
    db.query(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES (?, ?, ?, 'usr_owner', 0, 0)",
    ).run(weddingId, weddingId, weddingId);
    db.query(
      `INSERT INTO wedding_invite_customisations (wedding_id, ${CONTENT_COLUMNS.join(", ")}, updated_at)` +
        ` VALUES (?, ${CONTENT_COLUMNS.map(() => "?").join(", ")}, 1790000000)`,
    ).run(weddingId, ...CONTENT_COLUMNS.map((c) => content[c] ?? null));
  }
  for (const file of chain(63, 65)) apply(db, file);
  // An organiser switched every section of a filled invite off, and the FAQ of
  // two others.
  db.exec(
    "UPDATE wedding_invite_customisations SET hero_visible = 0, story_visible = 0, footer_visible = 0 WHERE wedding_id = 'wed_hidden'",
  );
  db.exec(
    "UPDATE wedding_invite_customisations SET faq_visible = 0 WHERE wedding_id IN ('wed_mixed', 'wed_on')",
  );
  return db;
}

describe("migration 0065", () => {
  it("starts from the switch-offs 0063 and an organiser left behind", () => {
    expect(chain(1, 63)).not.toContain("0063_invite_section_visibility.sql");
    expect(chain(63, 65)).toEqual(["0063_invite_section_visibility.sql", "0064_invite_faq.sql"]);
    const db = beforeMigration();
    expect(switchesOf(db, "wed_blank")).toEqual({
      hero_visible: 0,
      story_visible: 0,
      footer_visible: 0,
    });
    expect(switchesOf(db, "wed_mixed")).toEqual({
      hero_visible: 1,
      story_visible: 0,
      footer_visible: 0,
    });
    expect(switchesOf(db, "wed_no_hero")).toEqual({ ...ALL_ON, hero_visible: 0 });
    expect(switchesOf(db, "wed_no_story")).toEqual({ ...ALL_ON, story_visible: 0 });
    expect(switchesOf(db, "wed_no_closing")).toEqual({ ...ALL_ON, footer_visible: 0 });
    expect(switchesOf(db, "wed_hidden")).toEqual({
      hero_visible: 0,
      story_visible: 0,
      footer_visible: 0,
    });
    expect(switchesOf(db, "wed_on")).toEqual(ALL_ON);
    db.close();
  });

  it("switches the hero, Our Story and the closing section on for every invite", () => {
    const db = beforeMigration();
    apply(db, MIG_0065);
    for (const weddingId of Object.keys(FIXTURES)) {
      expect(switchesOf(db, weddingId), weddingId).toEqual(ALL_ON);
    }
    db.close();
  });

  it("leaves the FAQ switch alone", () => {
    const db = beforeMigration();
    apply(db, MIG_0065);
    const faq = db
      .query(
        "SELECT wedding_id, faq_visible FROM wedding_invite_customisations ORDER BY wedding_id",
      )
      .all();
    expect(faq).toEqual([
      { wedding_id: "wed_blank", faq_visible: 1 },
      { wedding_id: "wed_hidden", faq_visible: 1 },
      { wedding_id: "wed_mixed", faq_visible: 0 },
      { wedding_id: "wed_no_closing", faq_visible: 1 },
      { wedding_id: "wed_no_hero", faq_visible: 1 },
      { wedding_id: "wed_no_story", faq_visible: 1 },
      { wedding_id: "wed_on", faq_visible: 0 },
    ]);
    db.close();
  });

  it("changes no other column, updated_at included", () => {
    const db = beforeMigration();
    const before = everythingButTheSwitches(db);
    apply(db, MIG_0065);
    expect(everythingButTheSwitches(db)).toEqual(before);
    db.close();
  });

  it("writes only the rows with a switch off", () => {
    const db = beforeMigration();
    const changesBefore = totalChanges(db);
    apply(db, MIG_0065);
    // Every fixture but wed_on, which is already all on.
    expect(totalChanges(db) - changesBefore).toBe(Object.keys(FIXTURES).length - 1);
    db.close();
  });
});
