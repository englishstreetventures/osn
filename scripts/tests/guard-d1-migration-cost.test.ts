// The pure half of the D1 migration-cost guard: the statement splitter, the
// replay-and-count measurement, and the budgets-file parser. The CLI half —
// exit codes, the budgets lookup, the error text — is in the .cli.test.ts
// beside this file.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DAILY_ROWS_WRITTEN_CEILING,
  measureChain,
  parseBudgets,
  rebuildsPerDay,
  ROWS_WRITTEN_PER_SCHEMA_WRITE,
  splitSqlStatements,
} from "../guard-d1-migration-cost";

async function withChain<T>(
  files: Readonly<Record<string, string>>,
  run: (dir: string) => T,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "d1-migration-cost-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(dir, name), contents);
    }
    return run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("splits on Drizzle's statement-breakpoint marker", () => {
  const statements = splitSqlStatements(
    "CREATE TABLE `a` (`id` text);\n--> statement-breakpoint\nCREATE TABLE `b` (`id` text);",
  );
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("`a`");
  expect(statements[1]).toContain("`b`");
});

test("splits on bare semicolons too, since Drizzle does not breakpoint every pair", () => {
  const statements = splitSqlStatements("DROP TABLE `a`; DROP TABLE `b`; DROP TABLE `c`;");
  expect(statements).toHaveLength(3);
});

test("a semicolon inside a string default does not split the statement", () => {
  const statements = splitSqlStatements(
    "CREATE TABLE `a` (`note` text DEFAULT 'one; two' NOT NULL);",
  );
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain("one; two");
});

test("a doubled quote inside a string default does not end the string", () => {
  const statements = splitSqlStatements(
    "CREATE TABLE `a` (`note` text DEFAULT 'it''s; fine' NOT NULL);",
  );
  expect(statements).toHaveLength(1);
});

test("a semicolon inside a quoted identifier does not split the statement", () => {
  const statements = splitSqlStatements('CREATE TABLE "od;d" ("id" text);');
  expect(statements).toHaveLength(1);
});

test("a semicolon inside a comment does not split the statement", () => {
  const statements = splitSqlStatements(
    "-- a note; with a semicolon\nCREATE TABLE `a` (`id` text);\n/* another; one */\nCREATE TABLE `b` (`id` text);",
  );
  expect(statements).toHaveLength(2);
});

test("a trigger body's semicolons stay inside one statement", () => {
  const statements = splitSqlStatements(
    "CREATE TRIGGER `t` AFTER INSERT ON `a` BEGIN UPDATE `a` SET `id` = 'x'; DELETE FROM `a`; END;\n" +
      "--> statement-breakpoint\nCREATE TABLE `b` (`id` text);",
  );
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("DELETE FROM");
});

test("comment-only files contribute no statements", () => {
  expect(splitSqlStatements("-- nothing here\n\n/* nor here */\n")).toEqual([]);
});

test("each schema statement is one schema write", async () => {
  const cost = await withChain(
    {
      "0001_init.sql":
        "CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL, `spare` text);\n" +
        "--> statement-breakpoint\nCREATE INDEX `a_idx` ON `a` (`spare`);",
    },
    measureChain,
  );
  expect(cost.files).toBe(1);
  expect(cost.statements).toBe(2);
  expect(cost.schemaWrites).toBe(2);
  expect(cost.tableRebuilds).toBe(0);
  expect(cost.estimatedRowsWritten).toBe(2 * ROWS_WRITTEN_PER_SCHEMA_WRITE);
});

test("a dropped column is charged twice, because SQLite rebuilds the table", async () => {
  const cost = await withChain(
    {
      "0001_init.sql": "CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL, `spare` text);",
      "0002_drop.sql": "ALTER TABLE `a` DROP COLUMN `spare`;",
    },
    measureChain,
  );
  expect(cost.statements).toBe(2);
  expect(cost.schemaWrites).toBe(3);
  expect(cost.tableRebuilds).toBe(1);
});

test("the bare `DROP <column>` spelling is charged the same as `DROP COLUMN`", async () => {
  const cost = await withChain(
    {
      "0001_init.sql": "CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL, `spare` text);",
      "0002_drop.sql": "ALTER TABLE `a` DROP `spare`;",
    },
    measureChain,
  );
  expect(cost.schemaWrites).toBe(3);
  expect(cost.tableRebuilds).toBe(1);
});

test("a column default containing the word DROP is not mistaken for a rebuild", async () => {
  const cost = await withChain(
    {
      "0001_init.sql": "CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL);",
      "0002_add.sql": "ALTER TABLE `a` ADD `state` text DEFAULT 'DROP' NOT NULL;",
    },
    measureChain,
  );
  expect(cost.schemaWrites).toBe(2);
  expect(cost.tableRebuilds).toBe(0);
});

test("the __new_/__keep_ rebuild idiom is reported, and each of its statements charged once", async () => {
  const cost = await withChain(
    {
      "0001_init.sql": "CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL, `spare` text);",
      "0002_rebuild.sql":
        "CREATE TABLE `__new_a` (`id` text PRIMARY KEY NOT NULL);\n" +
        "--> statement-breakpoint\nINSERT INTO `__new_a` (`id`) SELECT `id` FROM `a`;\n" +
        "--> statement-breakpoint\nDROP TABLE `a`;\n" +
        "--> statement-breakpoint\nALTER TABLE `__new_a` RENAME TO `a`;",
    },
    measureChain,
  );
  expect(cost.statements).toBe(5);
  // The INSERT is a data statement: no schema write, and no rows to copy.
  expect(cost.schemaWrites).toBe(4);
  // The two schema statements naming the scratch table. The plain
  // `DROP TABLE a` beside them is an ordinary schema write.
  expect(cost.tableRebuilds).toBe(2);
  expect(cost.dataRows).toBe(0);
});

test("rows a migration really writes are counted from SQLite, not estimated", async () => {
  const cost = await withChain(
    {
      "0001_init.sql": "CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL);",
      "0002_backfill.sql": "INSERT INTO `a` (`id`) VALUES ('x'), ('y'), ('z');",
    },
    measureChain,
  );
  expect(cost.schemaWrites).toBe(1);
  expect(cost.dataRows).toBe(3);
  expect(cost.estimatedRowsWritten).toBe(ROWS_WRITTEN_PER_SCHEMA_WRITE + 3);
});

// `measureChain` is synchronous, so these assert on the call itself rather
// than on a rejected promise — the temp directory is the only async part.
test("a chain that does not apply throws rather than measuring cheap", async () => {
  await withChain({ "0001_init.sql": "CREATE INDEX `i` ON `nope` (`id`);" }, (dir) => {
    expect(() => measureChain(dir)).toThrow("0001_init.sql failed to apply");
  });
});

test("a directory with no migrations throws rather than passing", async () => {
  await withChain({ "README.md": "not a migration" }, (dir) => {
    expect(() => measureChain(dir)).toThrow("holds no .sql migrations");
  });
});

test("files are replayed in filename order", async () => {
  // 0002 depends on 0001 having run, so a chain measured out of order fails.
  const cost = await withChain(
    {
      "0002_add.sql": "ALTER TABLE `a` ADD `spare` text;",
      "0001_init.sql": "CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL);",
    },
    measureChain,
  );
  expect(cost.schemaWrites).toBe(2);
});

test("rebuildsPerDay divides the daily ceiling and rounds down", () => {
  expect(rebuildsPerDay(1000)).toBe(100);
  expect(rebuildsPerDay(7265)).toBe(13);
  expect(rebuildsPerDay(DAILY_ROWS_WRITTEN_CEILING + 1)).toBe(0);
});

test("parseBudgets reads a row and ignores comments and blank lines", () => {
  const records = parseBudgets(
    "# a note\n\ncire/db/migrations 3700 # measured 1836\n",
    "budgets.txt",
  );
  expect(records).toEqual([{ chain: "cire/db/migrations", budget: 3700 }]);
});

test("parseBudgets rejects a row with a missing field", () => {
  expect(() => parseBudgets("cire/db/migrations\n", "budgets.txt")).toThrow("budgets.txt:1");
});

test("parseBudgets rejects a row with an extra field", () => {
  expect(() => parseBudgets("cire/db/migrations 3700 extra\n", "budgets.txt")).toThrow(
    "budgets.txt:1",
  );
});

test("parseBudgets rejects a non-numeric budget", () => {
  expect(() => parseBudgets("cire/db/migrations lots\n", "budgets.txt")).toThrow(
    "budget must be a positive integer",
  );
});

test("parseBudgets rejects a file with no records at all", () => {
  expect(() => parseBudgets("# only a comment\n", "budgets.txt")).toThrow("has no records");
});

// The fixtures above prove the guard works. This one proves the tree it guards
// still passes it, so a migration that busts the budget fails `bun run
// test:scripts` as well as the workflow step.
test("every committed chain is inside its committed budget", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const budgetsFile = join(root, "scripts/d1-migration-cost-budgets.txt");
  const records = parseBudgets(readFileSync(budgetsFile, "utf8"), budgetsFile);

  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    const cost = measureChain(join(root, record.chain));
    expect(cost.estimatedRowsWritten).toBeLessThanOrEqual(record.budget);
  }
});
