import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Data proof for migration 0071, which moves ownership off
// `weddings.owner_osn_profile_id` and onto `wedding_hosts` as `owner` seats.
// Structural lockstep is ddl-lockstep.test.ts's job; what this replays is the
// one thing a structural diff cannot see — what becomes of the weddings, seats
// and guest data that already exist when the column goes.
//
// Reads cire/db/migrations/, the files wrangler applies. The D1 replay of the
// same file is in d1-integration.test.ts.
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

const MIG_0071 = "0071_wedding_owners.sql";

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

const count = (db: Database, table: string): number =>
  (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

type Seat = {
  id: string;
  wedding_id: string;
  osn_profile_id: string;
  added_by_osn_profile_id: string;
  role: string;
  run_sheet_scope: string;
  created_at: number;
};

const seats = (db: Database): Seat[] =>
  db
    .query(
      "SELECT id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, run_sheet_scope, created_at FROM wedding_hosts ORDER BY wedding_id, osn_profile_id",
    )
    .all() as Seat[];

/**
 * The database as 0071 finds it, under enforced foreign keys: two weddings,
 * one with a co-host and a household that has replied, and one whose owner
 * also holds a seat on it — which no API path writes, but nothing in the schema
 * forbids either.
 */
function beforeMigration(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of chain(1, 71)) apply(db, file);
  db.exec(`
    INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)
      VALUES ('wed_1', 'w1', 'W1', 'usr_owner1', 1000, 2000),
             ('wed_2', 'w2', 'W2', 'usr_owner2', 3000, 4000);
    INSERT INTO wedding_hosts (id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, created_at)
      VALUES ('whost_ed', 'wed_1', 'usr_ed', 'usr_owner1', 'editor', 1500),
             ('whost_dup', 'wed_2', 'usr_owner2', 'usr_someone', 'viewer', 3500);
    INSERT INTO host_rsvp_notices (wedding_id, osn_profile_id, seen_seq, digest_seq, digest_enabled, updated_at)
      VALUES ('wed_1', 'usr_owner1', 3, 3, 0, 1000);
    INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone)
      VALUES ('evt_1', 'wed_1', 'dinner', 'Dinner', '', '', 'UTC');
    INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at)
      VALUES ('fam_1', 'wed_1', 'CODE-0001', 'Sharma', 0, 0);
    INSERT INTO guests (id, family_id, first_name, created_at, updated_at)
      VALUES ('g_1', 'fam_1', 'Ada', 0, 0);
    INSERT INTO guest_events (guest_id, event_id) VALUES ('g_1', 'evt_1');
    INSERT INTO rsvps (id, guest_id, event_id, status, created_at)
      VALUES ('r_1', 'g_1', 'evt_1', 'attending', 0);
  `);
  return db;
}

const UUID_SEAT_ID = /^whost_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("migration 0071 — wedding owners become seats", () => {
  it("gives every wedding's owner an owner seat dated from the wedding, attributed to themselves", () => {
    const db = beforeMigration();
    apply(db, MIG_0071);

    const owner = seats(db).find((s) => s.osn_profile_id === "usr_owner1");
    expect(owner).toMatchObject({
      wedding_id: "wed_1",
      added_by_osn_profile_id: "usr_owner1",
      role: "owner",
      run_sheet_scope: "own",
      created_at: 1000,
    });
    expect(owner!.id).toMatch(UUID_SEAT_ID);
    db.close();
  });

  it("mints a different seat id for each wedding", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (const file of chain(1, 71)) apply(db, file);
    const values = Array.from(
      { length: 20 },
      (_, i) => `('wed_${i}', 'w${i}', 'W', 'usr_${i}', 0, 0)`,
    ).join(", ");
    db.exec(
      `INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at) VALUES ${values};`,
    );
    apply(db, MIG_0071);

    const ids = seats(db).map((s) => s.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) expect(id).toMatch(UUID_SEAT_ID);
    db.close();
  });

  it("makes an owner's existing seat on their own wedding the owner seat, keeping its id and history", () => {
    const db = beforeMigration();
    apply(db, MIG_0071);

    const onWed2 = seats(db).filter((s) => s.wedding_id === "wed_2");
    expect(onWed2).toEqual([
      {
        id: "whost_dup",
        wedding_id: "wed_2",
        osn_profile_id: "usr_owner2",
        added_by_osn_profile_id: "usr_someone",
        role: "owner",
        run_sheet_scope: "own",
        created_at: 3500,
      },
    ]);
    db.close();
  });

  it("leaves every other seat as it was", () => {
    const db = beforeMigration();
    apply(db, MIG_0071);

    expect(seats(db).find((s) => s.id === "whost_ed")).toEqual({
      id: "whost_ed",
      wedding_id: "wed_1",
      osn_profile_id: "usr_ed",
      added_by_osn_profile_id: "usr_owner1",
      role: "editor",
      run_sheet_scope: "own",
      created_at: 1500,
    });
    db.close();
  });

  it("keeps every wedding and all of its guest data — the column drop cascades nothing", () => {
    const db = beforeMigration();
    apply(db, MIG_0071);

    expect(count(db, "weddings")).toBe(2);
    expect(count(db, "families")).toBe(1);
    expect(count(db, "guests")).toBe(1);
    expect(count(db, "guest_events")).toBe(1);
    expect(count(db, "rsvps")).toBe(1);
    expect(count(db, "events")).toBe(1);
    expect(count(db, "host_rsvp_notices")).toBe(1);
    expect(
      db.query("SELECT id, slug, created_at, updated_at FROM weddings ORDER BY id").all(),
    ).toEqual([
      { id: "wed_1", slug: "w1", created_at: 1000, updated_at: 2000 },
      { id: "wed_2", slug: "w2", created_at: 3000, updated_at: 4000 },
    ]);
    db.close();
  });

  it("drops the owner column and its index", () => {
    const db = beforeMigration();
    apply(db, MIG_0071);

    const columns = (db.query("PRAGMA table_info(weddings)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("owner_osn_profile_id");
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'weddings_owner_idx'",
        )
        .get(),
    ).toBeNull();
    db.close();
  });

  it("holds one statement per breakpoint chunk, as D1's prepare needs, and never rebuilds weddings", () => {
    const text = readFileSync(join(MIGRATIONS_DIR, MIG_0071), "utf8");
    const chunks = text
      .split("--> statement-breakpoint")
      .map((chunk) =>
        chunk
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.replace(/;$/, "")).not.toContain(";");
    // A copy-and-swap drops `weddings`, which under D1's enforced foreign keys
    // deletes every child row of every wedding.
    expect(text).not.toContain("__new_weddings");
    expect(text).not.toMatch(/DROP TABLE/i);
  });
});
