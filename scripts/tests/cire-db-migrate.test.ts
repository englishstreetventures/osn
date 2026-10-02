// The pure half of scripts/cire-db-migrate.ts: the ledger rule, the reading of
// wrangler's JSON, and the argument check. The CLI half — what reaches
// wrangler's apply, and the exit code — is in the .cli.test.ts beside this file.
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
  CHAIN_STARTS,
  checkBaselineSchema,
  checkLedger,
  LEDGER_TABLE,
  migrationStatements,
  MIGRATIONS_DIR,
  namesOf,
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

// Where its chains began: the original one at 0002, and the chain an older
// baseline (standing for 0001-0003) started at 0004.
const STARTS = ["0002_add_rsvp.sql", "0004_indices.sql"] as const;

const check = (ledger: readonly string[] | null) => checkLedger(ledger, ARCHIVE, STARTS);

test("a database with no ledger table is fresh, and passes", () => {
  expect(check(null).ok).toBe(true);
});

test("an empty ledger is fresh, and passes", () => {
  expect(check([]).ok).toBe(true);
});

test("a ledger holding only the baseline passes the ledger rule and asks for the schema check", () => {
  // The state the nightly dev rebuild and `db:reset` leave behind, every time
  // they are checked — and also what an older baseline leaves, which only the
  // schema can tell apart.
  expect(check([BASELINE])).toMatchObject({ ok: true, baselineOnly: true });
});

test("a database built from the baseline with live migrations after it passes outright", () => {
  expect(check([BASELINE, "0007_next.sql", "0008_after.sql"])).toMatchObject({
    ok: true,
    baselineOnly: false,
  });
});

test("a database that applied the whole original chain passes", () => {
  // Production's shape once it has caught up.
  expect(check([...ARCHIVE]).ok).toBe(true);
});

test("a database built from an older baseline that applied everything after it passes", () => {
  // Dev's shape: the older baseline, then each migration it was given since.
  expect(check([BASELINE, "0004_indices.sql", "0005_hosts.sql", "0006_tiers.sql"])).toMatchObject({
    ok: true,
  });
});

test("a database part-way through the original chain is refused, naming what it lacks", () => {
  // Production's shape when its deploys have fallen behind main.
  const verdict = check([
    "0001_initial.sql",
    "0002_add_rsvp.sql",
    "0003_events.sql",
    "0004_indices.sql",
  ]);
  expect(verdict).toMatchObject({ ok: false, missing: ["0005_hosts.sql", "0006_tiers.sql"] });
  expect(verdict.message).toContain("0005_hosts.sql, 0006_tiers.sql");
  // Recovery ships the migrations with the code that matches them; applying
  // them by hand under an older Worker would break it.
  expect(verdict.message).toContain("approve the deploy run");
  expect(verdict.message).not.toContain("db:migrate");
});

test("a database part-way through after an older baseline is refused", () => {
  expect(check([BASELINE, "0004_indices.sql"])).toMatchObject({
    ok: false,
    missing: ["0005_hosts.sql", "0006_tiers.sql"],
  });
});

test("a gap inside the chain is refused even when the newest file was applied", () => {
  expect(check([BASELINE, "0004_indices.sql", "0006_tiers.sql"])).toMatchObject({
    ok: false,
    missing: ["0005_hosts.sql"],
  });
});

test("a ledger without the baseline's name is refused", () => {
  expect(check(["0002_add_rsvp.sql"])).toMatchObject({
    ok: false,
    missing: [BASELINE],
  });
});

test("ledger entries numbered after the archive are live migrations, left to wrangler", () => {
  expect(check([BASELINE, "0099_unknown.sql"]).ok).toBe(true);
});

test("a database that applied the whole original chain and live migrations after it passes", () => {
  // Production's shape from the first migration after the squash on.
  expect(check([...ARCHIVE, "0007_next.sql"])).toMatchObject({ ok: true, baselineOnly: false });
});

test("a chain whose archived entries begin anywhere but a chain start is refused", () => {
  // Wrangler applies in name order and stops at a failure, so a ledger never
  // starts part-way through a chain unless something outside wrangler wrote it.
  expect(check([BASELINE, "0005_hosts.sql", "0006_tiers.sql"])).toMatchObject({
    ok: false,
    missing: ["0004_indices.sql"],
  });
  expect(check([BASELINE, "0006_tiers.sql"])).toMatchObject({
    ok: false,
    missing: ["0004_indices.sql", "0005_hosts.sql"],
  });
  expect(check([BASELINE, "0003_events.sql", ...ARCHIVE.slice(3)])).toMatchObject({
    ok: false,
    missing: ["0002_add_rsvp.sql"],
  });
});

test("with no chain start at or before its first entry, the whole archive is required", () => {
  expect(
    checkLedger([BASELINE, "0004_indices.sql", "0005_hosts.sql", "0006_tiers.sql"], ARCHIVE, []),
  ).toMatchObject({ ok: false, missing: ["0002_add_rsvp.sql", "0003_events.sql"] });
});

test("an entry numbered within the archive that no archived chain holds is refused", () => {
  // A migration from an unmerged branch that reused a number, or a hand-edited
  // ledger: wrangler would skip the baseline over schema nobody can vouch for.
  const beside = check([BASELINE, "0003_myfeature.sql"]);
  expect(beside).toMatchObject({ ok: false, missing: ["0003_myfeature.sql"] });
  expect(beside.message).toContain("db:reset");
  expect(check([...ARCHIVE, "0006_other.sql"])).toMatchObject({
    ok: false,
    missing: ["0006_other.sql"],
  });
});

test("an entry with no migration number is refused", () => {
  expect(check([BASELINE, "notes.sql"])).toMatchObject({ ok: false, missing: ["notes.sql"] });
});

test("a ledger holding the baseline more than once still asks for the schema check", () => {
  expect(check([BASELINE, BASELINE])).toMatchObject({ ok: true, baselineOnly: true });
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

test("checkBaselineSchema refuses the same columns in a different order", () => {
  const stored = [
    "CREATE TABLE `weddings` (\n  `tier` text,\n  `id` text PRIMARY KEY NOT NULL\n)",
    "CREATE INDEX `weddings_tier_idx` ON `weddings` (`tier`)",
  ];
  expect(checkBaselineSchema(stored, BASELINE_SQL)).toMatchObject({
    ok: false,
    missing: ["CREATE TABLE `weddings`"],
  });
});

test("checkBaselineSchema names five differences and marks the rest as cut", () => {
  const six = Array.from({ length: 6 }, (_, i) => `CREATE TABLE \`t${i}\` (\`id\` text)`);
  const verdict = checkBaselineSchema([], six);
  expect(verdict).toMatchObject({ ok: false });
  expect(verdict.message).toContain("6 of the tables");
  expect(verdict.message).toContain("CREATE TABLE `t4`; …)");
  expect(verdict.message).not.toContain("`t5`");
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

test("parseD1Rows reads a row it cannot read as nulls rather than dropping it", () => {
  expect(parseD1Rows('[{"results":[{"name":7},"x"],"success":true}]')).toEqual([
    { name: null, sql: null },
    { name: null, sql: null },
  ]);
});

test("namesOf throws on a row with no readable name, so no ledger entry is lost", () => {
  expect(namesOf([{ name: "0001_initial.sql", sql: null }])).toEqual(["0001_initial.sql"]);
  expect(() =>
    namesOf([
      { name: "0001_initial.sql", sql: null },
      { name: null, sql: null },
    ]),
  ).toThrow("no readable name");
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

test("every chain start is an archived migration, the original chain's first among them", () => {
  for (const start of CHAIN_STARTS) expect(archive).toContain(start);
  expect(CHAIN_STARTS[0]).toBe(archive[1]);
  expect(CHAIN_STARTS).toEqual(CHAIN_STARTS.toSorted());
});

test("the real archive passes production's and dev's complete ledgers", () => {
  // Production applied the original chain file by file; dev was built from the
  // previous baseline and applied everything after it.
  expect(checkLedger([...archive], archive)).toMatchObject({ ok: true, baselineOnly: false });
  const afterOlderBaseline = archive.slice(archive.indexOf(CHAIN_STARTS[1]!));
  expect(checkLedger([BASELINE, ...afterOlderBaseline], archive)).toMatchObject({ ok: true });
});

test("the real archive refuses production at its last deploy, naming 0062 onwards", () => {
  const atLastDeploy = archive.filter((name) => name < "0062");
  const verdict = checkLedger(atLastDeploy, archive);
  expect(verdict).toMatchObject({ ok: false, missing: archive.filter((name) => name >= "0062") });
  expect(verdict.message).toContain("0062_gift_note_hidden.sql");
});

test("the real archive refuses a ledger that skipped the first file of a chain", () => {
  const skipped = archive.slice(archive.indexOf(CHAIN_STARTS[1]!) + 1);
  expect(checkLedger([BASELINE, ...skipped], archive)).toMatchObject({
    ok: false,
    missing: [CHAIN_STARTS[1]],
  });
});

test("the real archive refuses a stray migration that reused an archived number", () => {
  expect(checkLedger([BASELINE, "0058_myfeature.sql"], archive)).toMatchObject({
    ok: false,
    missing: ["0058_myfeature.sql"],
  });
});

// The ledger read assumes wrangler keeps its ledger in d1_migrations and
// applies this script's MIGRATIONS_DIR; both come from cire/api/wrangler.toml.
test("every cire D1 block in wrangler.toml uses the ledger table and directory this script reads", () => {
  type D1Block = { migrations_dir?: string; migrations_table?: string };
  const config = Bun.TOML.parse(
    readFileSync(resolve(MIGRATIONS_DIR, "..", "..", "api", "wrangler.toml"), "utf8"),
  ) as { d1_databases?: D1Block[]; env?: Record<string, { d1_databases?: D1Block[] }> };
  const blocks = [
    ...(config.d1_databases ?? []),
    ...Object.values(config.env ?? {}).flatMap((env) => env.d1_databases ?? []),
  ];
  expect(blocks.length).toBe(3);
  for (const block of blocks) {
    expect(resolve(MIGRATIONS_DIR, "..", "..", "api", block.migrations_dir ?? "")).toBe(
      MIGRATIONS_DIR,
    );
    expect(block.migrations_table ?? LEDGER_TABLE).toBe(LEDGER_TABLE);
  }
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

test("the real baseline refuses every older baseline since the one before it", () => {
  // Replaying the archive up to some earlier point leaves the shape an older
  // baseline built, under the same single ledger entry. One replay, checked
  // after each file from the previous baseline's point to one short of the end.
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const lastPrevious = archive.indexOf(CHAIN_STARTS.at(-1)!) - 1;
    const refused: string[] = [];
    for (const [index, file] of archive.slice(0, -1).entries()) {
      db.exec(readFileSync(resolve(ARCHIVE_DIR, file), "utf8"));
      if (index < lastPrevious) continue;
      const stored = (
        db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<{
          sql: string;
        }>
      ).map((row) => row.sql);
      if (!checkBaselineSchema(stored, baseline).ok) refused.push(file);
    }
    expect(refused).toEqual(archive.slice(lastPrevious, -1));
  } finally {
    db.close();
  }
});
