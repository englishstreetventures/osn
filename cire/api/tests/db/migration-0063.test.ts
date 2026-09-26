import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Data proof for migration 0063 (the per-section visibility switches).
// Structural lockstep is ddl-lockstep.test.ts's job; what this replays is what
// happens to a customisation row that already existed when the columns arrived.
//
// Each switch must come out as what that section's emptiness check gave before
// the migration: content ⇒ on, no content ⇒ off. "Content" is the rule both
// emptiness modules implement — text with something besides whitespace, or an
// image key the API would build a URL from.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const MIG_0063 = "0063_invite_section_visibility.sql";

function apply(db: Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

/** The chain as it stood before 0063. */
function applyBaseline(db: Database): void {
  for (const file of [
    "0001_initial.sql",
    "0058_gift_summary_and_stripe_state.sql",
    "0059_rsvp_dietary_presets.sql",
    "0060_helper_role_and_run_sheet_scope.sql",
    "0061_upgrade_purchases.sql",
    "0062_gift_note_hidden.sql",
  ]) {
    apply(db, file);
  }
}

type Row = {
  wedding_id: string;
  hero_title?: string | null;
  hero_subtitle?: string | null;
  hero_image_key?: string | null;
  story_eyebrow?: string | null;
  story_heading?: string | null;
  story_body?: string | null;
  story_image_key?: string | null;
  footer_message?: string | null;
  footer_image_key?: string | null;
};

const COLUMNS = [
  "hero_title",
  "hero_subtitle",
  "hero_image_key",
  "story_eyebrow",
  "story_heading",
  "story_body",
  "story_image_key",
  "footer_message",
  "footer_image_key",
] as const;

/** Seed one wedding + its customisation row per fixture. */
function seed(db: Database, rows: Row[]): void {
  for (const row of rows) {
    db.query(
      "INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)" +
        " VALUES (?, ?, ?, 'usr_owner', 0, 0)",
    ).run(row.wedding_id, row.wedding_id, row.wedding_id);
    db.query(
      `INSERT INTO wedding_invite_customisations (wedding_id, ${COLUMNS.join(", ")}, updated_at)` +
        ` VALUES (?, ${COLUMNS.map(() => "?").join(", ")}, 0)`,
    ).run(row.wedding_id, ...COLUMNS.map((c) => row[c] ?? null));
  }
}

type Switches = { hero_visible: number; story_visible: number; footer_visible: number };

function switchesOf(db: Database, weddingId: string): Switches {
  return db
    .query(
      "SELECT hero_visible, story_visible, footer_visible FROM wedding_invite_customisations WHERE wedding_id = ?",
    )
    .get(weddingId) as Switches;
}

function migrated(rows: Row[]): Database {
  const db = new Database(":memory:");
  applyBaseline(db);
  seed(db, rows);
  apply(db, MIG_0063);
  return db;
}

// Every character JavaScript's String.prototype.trim removes, derived from
// JavaScript itself so the set is complete by construction: the migration's five
// trim lists have to match it, and a list missing a character goes red below.
const JS_WHITESPACE = Array.from({ length: 0x10000 }, (_, code) => code)
  .filter((code) => (code < 0xd800 || code > 0xdfff) && String.fromCharCode(code).trim() === "")
  .map((code) => String.fromCharCode(code))
  .join("");

/** The five text columns the backfill trims, with the switch each one feeds. */
const TEXT_COLUMNS = [
  ["hero_title", "hero_visible"],
  ["hero_subtitle", "hero_visible"],
  ["story_heading", "story_visible"],
  ["story_body", "story_visible"],
  ["footer_message", "footer_visible"],
] as const;

describe("migration 0063", () => {
  it("switches off every section of a row with no content at all", () => {
    const db = migrated([{ wedding_id: "wed_blank" }]);
    expect(switchesOf(db, "wed_blank")).toEqual({
      hero_visible: 0,
      story_visible: 0,
      footer_visible: 0,
    });
    db.close();
  });

  it("switches on every section that has content", () => {
    const db = migrated([
      {
        wedding_id: "wed_full",
        hero_title: "Anita & Ben",
        story_body: "We met on a train.",
        footer_message: "No boxed gifts please",
      },
    ]);
    expect(switchesOf(db, "wed_full")).toEqual({
      hero_visible: 1,
      story_visible: 1,
      footer_visible: 1,
    });
    db.close();
  });

  it("keeps a section on for any single field that gives it content", () => {
    const db = migrated([
      { wedding_id: "hero_image", hero_image_key: "assets/w/hero-1" },
      { wedding_id: "hero_subtitle", hero_subtitle: "Save the date" },
      { wedding_id: "story_heading", story_heading: "How it began" },
      { wedding_id: "story_image", story_image_key: "assets/w/story-1" },
      { wedding_id: "footer_image", footer_image_key: "assets/w/footer-1" },
    ]);
    expect(switchesOf(db, "hero_image").hero_visible).toBe(1);
    expect(switchesOf(db, "hero_subtitle").hero_visible).toBe(1);
    expect(switchesOf(db, "story_heading").story_visible).toBe(1);
    expect(switchesOf(db, "story_image").story_visible).toBe(1);
    expect(switchesOf(db, "footer_image").footer_visible).toBe(1);
    // Each section is judged on its own fields only.
    expect(switchesOf(db, "hero_image").story_visible).toBe(0);
    expect(switchesOf(db, "story_image").footer_visible).toBe(0);
    db.close();
  });

  it("does not count whitespace as content, for any character JavaScript trims, in any column", () => {
    expect(JS_WHITESPACE.length).toBe(25);
    for (const [column, visibleColumn] of TEXT_COLUMNS) {
      // The whole set at once, and each character on its own: a trim list
      // missing one would keep a lone copy of it as text.
      const rows: Row[] = [
        { wedding_id: "wed_all", [column]: JS_WHITESPACE },
        ...[...JS_WHITESPACE].map((ch, i) => ({ wedding_id: `wed_${i}`, [column]: ch + ch })),
      ];
      const db = migrated(rows);
      for (const row of rows) {
        expect(switchesOf(db, row.wedding_id)[visibleColumn], `${column} ${row.wedding_id}`).toBe(
          0,
        );
      }
      db.close();
    }
  });

  it("counts text padded with whitespace as content", () => {
    const db = migrated([{ wedding_id: "wed_pad", footer_message: "  With love \n" }]);
    expect(switchesOf(db, "wed_pad").footer_visible).toBe(1);
    db.close();
  });

  it("does not let the story eyebrow keep the story on — it is a label", () => {
    const db = migrated([{ wedding_id: "wed_eyebrow", story_eyebrow: "Our Story" }]);
    expect(switchesOf(db, "wed_eyebrow").story_visible).toBe(0);
    db.close();
  });

  it("does not count an empty-string image key as an image", () => {
    const db = migrated([{ wedding_id: "wed_key", hero_image_key: "", story_image_key: "" }]);
    expect(switchesOf(db, "wed_key")).toMatchObject({ hero_visible: 0, story_visible: 0 });
    db.close();
  });

  it("leaves every content column untouched", () => {
    const fixture: Row = {
      wedding_id: "wed_keep",
      hero_title: "  A & B  ",
      story_eyebrow: "Our Story",
      footer_image_key: "assets/w/footer-1",
    };
    const db = new Database(":memory:");
    applyBaseline(db);
    seed(db, [fixture]);
    const select = `SELECT ${COLUMNS.join(", ")} FROM wedding_invite_customisations`;
    const before = db.query(select).all();
    apply(db, MIG_0063);
    expect(db.query(select).all()).toEqual(before);
    db.close();
  });

  it("gives a row inserted after 0063 every switch on", () => {
    const db = migrated([]);
    seed(db, [{ wedding_id: "wed_new" }]);
    expect(switchesOf(db, "wed_new")).toEqual({
      hero_visible: 1,
      story_visible: 1,
      footer_visible: 1,
    });
    db.close();
  });
});
