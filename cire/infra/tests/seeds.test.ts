import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { listMigrations, migrationStatements } from "../../../scripts/migration-files";
import { DEV_OWNER_PROFILE_ID, DEV_OWNER_SEAT_ID } from "../../db/seed/data/wedding";
import { ownerSeatSql, SeedInputError } from "../src/seeds";

const cireDb = fileURLToPath(new URL("../../db/", import.meta.url));

const seedScript = readFileSync(
  fileURLToPath(new URL("../../../scripts/cire-db-seed.sh", import.meta.url)),
  "utf8",
);

/**
 * The owner-seat statements `scripts/cire-db-seed.sh` runs for a profile id,
 * one per entry: its `--command` string with the seat id and the profile id
 * substituted.
 */
function scriptStatements(profileId: string): string[] {
  const seatId = /^\s*OWNER_SEAT_ID="([^"]+)"$/m.exec(seedScript)?.[1];
  const command = /--command \\\n\s*"(DELETE FROM wedding_hosts[^"]+)"/.exec(seedScript)?.[1];
  if (seatId === undefined || command === undefined) {
    throw new Error("scripts/cire-db-seed.sh no longer holds the owner-seat override");
  }
  return statements(
    command
      .replaceAll("${OWNER_SEAT_ID}", seatId)
      .replaceAll("${CIRE_DEV_OWNER_PROFILE_ID}", profileId),
  );
}

/** Each SQL statement in `sql`, trimmed, with `--` comment lines left out. */
const statements = (sql: string): string[] =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter((statement) => statement !== "");

interface SeatRow {
  readonly osn_profile_id: string;
  readonly added_by_osn_profile_id: string;
  readonly role: string;
}

/**
 * SQLite migrated through cire/db's migrations, foreign keys on as on D1, and
 * loaded with the dev seed: what the stack's dev database holds before
 * Alchemy imports the owner-seat file after it.
 */
function seededDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = join(cireDb, "migrations");
  for (const file of listMigrations(migrations)) {
    for (const statement of migrationStatements(readFileSync(join(migrations, file), "utf8"))) {
      db.exec(statement);
    }
  }
  db.exec(readFileSync(join(cireDb, "seed/dev-seed.sql"), "utf8"));
  return db;
}

describe("ownerSeatSql", () => {
  test("S6: an invalid profile id is refused, naming the variable only; unset or empty seeds nothing; a valid one gives the seed script's two statements", () => {
    const messages = new Set<string>();
    for (const value of [
      " ",
      "usr_",
      "profile_abc",
      " usr_abc",
      "usr_abc ",
      "usr_abc'; DELETE FROM weddings; --",
      "usr_abc\nDELETE FROM weddings",
      "usr_abc.def",
    ]) {
      let refused: unknown;
      try {
        ownerSeatSql(value);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(SeedInputError);
      expect(refused).toMatchObject({ input: "CIRE_DEV_OWNER_PROFILE_ID" });
      messages.add((refused as SeedInputError).message);
    }
    // The value can carry SQL, so the message is the same whatever it is: it
    // never repeats it. It names the variable the deploy log should point at.
    expect(messages.size).toBe(1);
    expect([...messages][0]).toMatch(/^CIRE_DEV_OWNER_PROFILE_ID is not a profile id/);

    // An unset GitHub variable reaches the step as an empty string.
    expect(ownerSeatSql(undefined)).toBeNull();
    expect(ownerSeatSql("")).toBeNull();

    const profileId = "usr_Ab3-x_9";
    const sql = ownerSeatSql(profileId);
    expect(sql).not.toBeNull();
    expect(statements(sql ?? "")).toEqual(scriptStatements(profileId));
    expect(statements(sql ?? "")).toHaveLength(2);
  });

  test("S5: identical inputs give identical bytes, so a second deploy re-imports nothing", () => {
    expect(ownerSeatSql("usr_Ab3-x_9")).toBe(ownerSeatSql("usr_Ab3-x_9"));
    expect(ownerSeatSql("usr_Ab3-x_9")).not.toBe(ownerSeatSql("usr_other"));
  });

  test("S11: imported after the dev seed, it moves the seed's owner seat to the profile, which keeps one seat on the wedding", () => {
    const seat = (db: Database) =>
      db
        .query<SeatRow, [string]>(
          "SELECT osn_profile_id, added_by_osn_profile_id, role FROM wedding_hosts WHERE id = ?",
        )
        .get(DEV_OWNER_SEAT_ID);
    const seatsOf = (db: Database, profileId: string) =>
      db
        .query<{ readonly id: string }, [string]>(
          "SELECT id FROM wedding_hosts WHERE wedding_id = 'wed_bootstrap' AND osn_profile_id = ?",
        )
        .all(profileId)
        .map((row) => row.id);

    const db = seededDb();
    expect(seat(db)).toEqual({
      osn_profile_id: DEV_OWNER_PROFILE_ID,
      added_by_osn_profile_id: DEV_OWNER_PROFILE_ID,
      role: "owner",
    });
    db.exec(ownerSeatSql("usr_Ab3-x_9") ?? "");
    expect(seat(db)).toEqual({
      osn_profile_id: "usr_Ab3-x_9",
      added_by_osn_profile_id: "usr_Ab3-x_9",
      role: "owner",
    });
    expect(seatsOf(db, "usr_Ab3-x_9")).toEqual([DEV_OWNER_SEAT_ID]);

    // A profile the seed already seats on the wedding gives up that seat for the owner's.
    const cohost = seededDb();
    const [cohostSeat] = seatsOf(cohost, "usr_dev_cohost_partner");
    expect(cohostSeat).toBeDefined();
    expect(cohostSeat).not.toBe(DEV_OWNER_SEAT_ID);
    cohost.exec(ownerSeatSql("usr_dev_cohost_partner") ?? "");
    expect(seatsOf(cohost, "usr_dev_cohost_partner")).toEqual([DEV_OWNER_SEAT_ID]);
    expect(seat(cohost)?.role).toBe("owner");
  });
});
