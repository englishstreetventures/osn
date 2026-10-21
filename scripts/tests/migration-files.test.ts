import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listMigrations, migrationStatements } from "../migration-files";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migration-files-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const touch = (...names: string[]) => {
  for (const name of names) writeFileSync(join(dir, name), "SELECT 1;");
};

// ── listMigrations ───────────────────────────────────────────────────────────

test("listMigrations orders by the leading number, as wrangler does, not by text", () => {
  touch("10_ten.sql", "9_nine.sql", "0100_hundred.sql");
  expect(listMigrations(dir)).toEqual(["9_nine.sql", "10_ten.sql", "0100_hundred.sql"]);
});

test("listMigrations puts a timestamped migration after every numbered one", () => {
  touch("20261021031500_add_x.sql", "0090_event_venue_name.sql", "0001_initial.sql");
  expect(listMigrations(dir)).toEqual([
    "0001_initial.sql",
    "0090_event_venue_name.sql",
    "20261021031500_add_x.sql",
  ]);
});

test("listMigrations breaks a tie on the number by name", () => {
  touch("0011_wedding_code_style.sql", "0011_dietary_consent.sql");
  expect(listMigrations(dir)).toEqual(["0011_dietary_consent.sql", "0011_wedding_code_style.sql"]);
});

test("listMigrations lists only .sql files, never a README or a snapshot", () => {
  touch("0001_initial.sql", "README.md", "0002_x.json");
  expect(listMigrations(dir)).toEqual(["0001_initial.sql"]);
});

test("listMigrations never descends into a directory, meta/ included", () => {
  touch("0001_initial.sql");
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta", "0001_snapshot.sql"), "SELECT 1;");
  mkdirSync(join(dir, "20261021031500_folder"));
  writeFileSync(join(dir, "20261021031500_folder", "migration.sql"), "SELECT 1;");
  expect(listMigrations(dir)).toEqual(["0001_initial.sql"]);
});

test("listMigrations with `newLast` moves those files to the end, in order, dropping none", () => {
  touch("0001_initial.sql", "20261021000001_a.sql", "20261021000002_b.sql", "20261021000003_c.sql");
  expect(
    listMigrations(dir, { newLast: ["20261021000001_a.sql", "20261021000003_c.sql"] }),
  ).toEqual([
    "0001_initial.sql",
    "20261021000002_b.sql",
    "20261021000001_a.sql",
    "20261021000003_c.sql",
  ]);
});

test("listMigrations with `newLast` refuses a name the directory does not hold", () => {
  touch("0001_initial.sql");
  expect(() => listMigrations(dir, { newLast: ["20261021000001_gone.sql"] })).toThrow(
    /20261021000001_gone\.sql/,
  );
});

// ── migrationStatements ──────────────────────────────────────────────────────

test("migrationStatements splits on breakpoints and drops comment lines", () => {
  expect(
    migrationStatements(
      "-- header\n\nCREATE TABLE `a` (`id` text);\n--> statement-breakpoint\nCREATE INDEX `i` ON `a` (`id`);\n",
    ),
  ).toEqual(["CREATE TABLE `a` (`id` text);", "CREATE INDEX `i` ON `a` (`id`);"]);
});

test("migrationStatements finds no statement in a file of comments only", () => {
  expect(migrationStatements("-- nothing here\n-- or here\n")).toEqual([]);
});

test("migrationStatements keeps a statement whose line ends in a comment", () => {
  expect(migrationStatements("ALTER TABLE `a` ADD `b` text; -- why\n")).toEqual([
    "ALTER TABLE `a` ADD `b` text; -- why",
  ]);
});

test("migrationStatements yields nothing for a trailing breakpoint", () => {
  expect(migrationStatements("SELECT 1;\n--> statement-breakpoint\n")).toEqual(["SELECT 1;"]);
});
