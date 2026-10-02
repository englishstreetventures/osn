// The pure half of scripts/cire-db-migrate.ts: the ledger rule, the reading of
// wrangler's JSON, and the argument check. The CLI half — exit codes before any
// wrangler call — is in the .cli.test.ts beside this file.
//
// The ledger shapes below are the ones deployed cire databases really hold:
// production applied the original chain file by file, dev is rebuilt nightly
// from the baseline and migrated forward on every merge, and a fresh database
// has no ledger table at all.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ARCHIVE_DIR,
  archivedMigrations,
  BASELINE,
  checkBaselineSchema,
  checkLedger,
  migrationStatements,
  MIGRATIONS_DIR,
  parseArgs,
  parseD1Rows,
} from "../cire-db-migrate";

// A small archive with the real one's shape: the original first migration
// shares the baseline's name, then the chain runs on contiguously.
const ARCHIVE = [
  "0001_initial.sql",
  "0002_add_rsvp.sql",
  "0003_events.sql",
  "0004_indices.sql",
  "0005_hosts.sql",
  "0006_tiers.sql",
] as const;

test("a database with no ledger table is fresh, and passes", () => {
  expect(checkLedger(null, ARCHIVE).ok).toBe(true);
});

test("an empty ledger is fresh, and passes", () => {
  expect(checkLedger([], ARCHIVE).ok).toBe(true);
});

test("a ledger holding only the baseline passes the ledger rule and asks for the schema check", () => {
  // The state the nightly dev rebuild and `db:reset` leave behind, every time
  // they are checked — and also what an older baseline leaves, which only the
  // schema can tell apart.
  expect(checkLedger([BASELINE], ARCHIVE)).toMatchObject({ ok: true, baselineOnly: true });
});

test("a database built from the baseline with live migrations after it passes outright", () => {
  expect(checkLedger([BASELINE, "0007_next.sql", "0008_after.sql"], ARCHIVE)).toMatchObject({
    ok: true,
    baselineOnly: false,
  });
});

test("a database that applied the whole original chain passes", () => {
  // Production's shape once it has caught up.
  expect(checkLedger([...ARCHIVE], ARCHIVE).ok).toBe(true);
});

test("a database built from an older baseline that applied everything after it passes", () => {
  // Dev's shape: the older baseline, then each migration it was given since.
  expect(
    checkLedger([BASELINE, "0004_indices.sql", "0005_hosts.sql", "0006_tiers.sql"], ARCHIVE),
  ).toMatchObject({ ok: true });
});

test("a database part-way through the original chain is refused, naming what it lacks", () => {
  // Production's shape when its deploys have fallen behind main.
  const verdict = checkLedger(
    ["0001_initial.sql", "0002_add_rsvp.sql", "0003_events.sql", "0004_indices.sql"],
    ARCHIVE,
  );
  expect(verdict).toMatchObject({ ok: false, missing: ["0005_hosts.sql", "0006_tiers.sql"] });
  expect(verdict.message).toContain("0005_hosts.sql, 0006_tiers.sql");
  // Recovery ships the migrations with the code that matches them; applying
  // them by hand under an older Worker would break it.
  expect(verdict.message).toContain("approve the deploy run");
  expect(verdict.message).not.toContain("db:migrate");
});

test("a database part-way through after an older baseline is refused", () => {
  expect(checkLedger([BASELINE, "0004_indices.sql"], ARCHIVE)).toMatchObject({
    ok: false,
    missing: ["0005_hosts.sql", "0006_tiers.sql"],
  });
});

test("a gap inside the chain is refused even when the newest file was applied", () => {
  expect(checkLedger([BASELINE, "0004_indices.sql", "0006_tiers.sql"], ARCHIVE)).toMatchObject({
    ok: false,
    missing: ["0005_hosts.sql"],
  });
});

test("a ledger without the baseline's name is refused", () => {
  expect(checkLedger(["0002_add_rsvp.sql"], ARCHIVE)).toMatchObject({
    ok: false,
    missing: [BASELINE],
  });
});

test("ledger entries the archive does not know are left to wrangler", () => {
  expect(checkLedger([BASELINE, "0099_unknown.sql"], ARCHIVE).ok).toBe(true);
});

// ── the schema behind a baseline-only ledger ─────────────────────────────────

const BASELINE_SQL = [
  "CREATE TABLE `weddings` (\n  `id` text PRIMARY KEY NOT NULL,\n  `tier` text\n);",
  "CREATE INDEX `weddings_tier_idx` ON `weddings` (`tier`);",
];

test("checkBaselineSchema passes a database holding every baseline statement, however spelled", () => {
  const stored = [
    'CREATE TABLE "weddings" ( `id` text PRIMARY KEY NOT NULL, `tier` text )',
    "create index weddings_tier_idx on weddings (tier)",
    "CREATE TABLE `extra` (`id` text)",
  ];
  expect(checkBaselineSchema(stored, BASELINE_SQL)).toMatchObject({ ok: true });
});

test("checkBaselineSchema refuses an older baseline, naming what differs", () => {
  const stored = ["CREATE TABLE `weddings` (\n  `id` text PRIMARY KEY NOT NULL\n)"];
  const verdict = checkBaselineSchema(stored, BASELINE_SQL);
  expect(verdict).toMatchObject({
    ok: false,
    missing: ["CREATE TABLE `weddings`", "CREATE INDEX `weddings_tier_idx` ON `weddings`"],
  });
  expect(verdict.message).toContain("older baseline");
  expect(verdict.message).toContain("cire-dev-db-rebuild.yml");
});

test("migrationStatements splits on breakpoints and drops comment lines", () => {
  expect(
    migrationStatements(
      "-- header\n\nCREATE TABLE `a` (`id` text);\n--> statement-breakpoint\nCREATE INDEX `i` ON `a` (`id`);\n",
    ),
  ).toEqual(["CREATE TABLE `a` (`id` text);", "CREATE INDEX `i` ON `a` (`id`);"]);
});

// ── wrangler's JSON ──────────────────────────────────────────────────────────

const RESULT =
  '[\n  {\n    "results": [{ "name": "0001_initial.sql" }],\n    "success": true\n  }\n]\n';

test("parseD1Rows reads the rows of the first result set", () => {
  expect(parseD1Rows(RESULT)).toEqual([{ name: "0001_initial.sql", sql: null }]);
});

test("parseD1Rows reads an empty result set as no rows", () => {
  expect(parseD1Rows('[{"results":[],"success":true,"meta":{"duration":0}}]')).toEqual([]);
});

test("parseD1Rows skips lines printed before the JSON, a bracketed banner included", () => {
  expect(parseD1Rows(`▲ [WARNING] something\n[WARNING] more\n${RESULT}`)).toEqual([
    { name: "0001_initial.sql", sql: null },
  ]);
});

test("parseD1Rows throws on wrangler's error object, quoting it", () => {
  expect(() => parseD1Rows('{"error":{"text":"no such table: d1_migrations"}}')).toThrow(
    "no such table: d1_migrations",
  );
});

test("parseD1Rows throws on a failed result", () => {
  expect(() => parseD1Rows('[{"results":[],"success":false}]')).toThrow("unreadable");
});

test("parseD1Rows throws on empty output", () => {
  expect(() => parseD1Rows("")).toThrow("(empty)");
});

// ── arguments ────────────────────────────────────────────────────────────────

test("parseArgs takes the database name and passes every flag through", () => {
  expect(parseArgs(["cire-db", "--env", "production", "--remote"])).toEqual({
    database: "cire-db",
    flags: ["--env", "production", "--remote"],
  });
});

test("parseArgs refuses a missing database name", () => {
  expect(parseArgs([])).toHaveProperty("error");
  expect(parseArgs(["--local"])).toHaveProperty("error");
});

test("parseArgs refuses a call that names neither --local nor --remote, or both", () => {
  expect(parseArgs(["cire-db"])).toHaveProperty("error");
  expect(parseArgs(["cire-db", "--local", "--remote"])).toHaveProperty("error");
});

// ── the real archive ─────────────────────────────────────────────────────────

const archive = archivedMigrations();

// The rule reads "from the first archived file a ledger holds to the newest",
// which only means anything if the archive has no holes and ends where the
// baseline's journal entry says it does.
test("the real archive runs from 0001 to the baseline's journal index with no gaps", () => {
  const journal = JSON.parse(
    readFileSync(resolve(ARCHIVE_DIR, "..", "migrations", "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const baseline = journal.entries.find((e) => `${e.tag}.sql` === BASELINE);
  expect(baseline).toBeDefined();
  expect(archive.map((name) => Number(name.slice(0, 4)))).toEqual(
    Array.from({ length: baseline!.idx }, (_, i) => i + 1),
  );
  expect(archive[0]).toBe(BASELINE);
});

test("the real archive refuses a ledger that stopped part-way and passes a complete one", () => {
  const behind = archive.slice(0, archive.length - 3);
  expect(checkLedger(behind, archive)).toMatchObject({ ok: false, missing: archive.slice(-3) });
  expect(checkLedger([...archive], archive).ok).toBe(true);
});

/** What SQLite stores for every table and index after running `files` from `dir`. */
function storedSql(dir: string, files: readonly string[]): string[] {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const file of files) db.exec(readFileSync(resolve(dir, file), "utf8"));
    return (
      db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<{
        sql: string;
      }>
    ).map((row) => row.sql);
  } finally {
    db.close();
  }
}

const baseline = migrationStatements(readFileSync(resolve(MIGRATIONS_DIR, BASELINE), "utf8"));

test("the real baseline passes a database it built itself", () => {
  expect(checkBaselineSchema(storedSql(MIGRATIONS_DIR, [BASELINE]), baseline).ok).toBe(true);
});

test("the real baseline refuses a database an older baseline built", () => {
  // Replaying the archive up to some earlier point leaves the shape an older
  // baseline built, under the same single ledger entry.
  const older = storedSql(ARCHIVE_DIR, archive.slice(0, archive.length - 5));
  expect(checkBaselineSchema(older, baseline).ok).toBe(false);
});
