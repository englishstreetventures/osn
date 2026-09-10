// The CLI half of the D1 migration-cost guard. The tests beside this file
// import the measurement functions directly and never reach the
// `import.meta.main` block, so they say nothing about exit codes, the budgets
// lookup, or the message a failing run prints — which is the whole of what CI
// and a reviewer actually see. These run the real, unmodified script as a
// subprocess against fixture chains, pointing its two environment overrides at
// a throwaway tree instead of this repo's own.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_SCRIPT = new URL("../guard-d1-migration-cost.ts", import.meta.url).pathname;

type Run = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

/**
 * Build a fixture tree — a budgets file plus one directory per chain — and run
 * the real script against it.
 */
async function runCli(
  budgets: string,
  chains: Readonly<Record<string, Readonly<Record<string, string>>>>,
  argument = "--all",
): Promise<Run> {
  const root = await mkdtemp(join(tmpdir(), "d1-migration-cost-cli-"));

  try {
    const budgetsFile = join(root, "budgets.txt");
    await writeFile(budgetsFile, budgets);

    for (const [chain, files] of Object.entries(chains)) {
      const dir = join(root, chain);
      await mkdir(dir, { recursive: true });
      for (const [name, contents] of Object.entries(files)) {
        await writeFile(join(dir, name), contents);
      }
    }

    const proc = Bun.spawn(["bun", "run", REAL_SCRIPT, argument.replace("<root>", root)], {
      cwd: root,
      env: {
        ...process.env,
        D1_MIGRATION_COST_BUDGETS_FILE: budgetsFile,
        D1_MIGRATION_COST_BUDGETS_ROOT: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ONE_TABLE = {
  "0001_initial.sql":
    "CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL, `spare` text);\n" +
    "--> statement-breakpoint\nCREATE INDEX `a_idx` ON `a` (`spare`);",
};

test("a chain inside its budget exits 0 and prints the cost, the ceiling and the headroom", async () => {
  const { exitCode, stdout, stderr } = await runCli("db/migrations 1000\n", {
    "db/migrations": ONE_TABLE,
  });

  expect(stderr).toBe("");
  // Two schema writes at 27 rows apiece.
  expect(stdout).toContain("2 schema writes");
  expect(stdout).toContain("about 54 D1 rows written");
  expect(stdout).toContain("100000/day free-tier ceiling");
  expect(stdout).toContain("946 rows of headroom");
  expect(exitCode).toBe(0);
});

test("the printed affordability is the daily ceiling divided by the cost", async () => {
  const { stdout } = await runCli("db/migrations 1000\n", { "db/migrations": ONE_TABLE });
  // 100,000 / 54, hedged because the price per schema write is only pinned to
  // a band.
  expect(stdout).toContain("that affords roughly 1851 replay(s) a day");
});

// Every row figure the guard prints is priced by a constant the evidence pins
// only to about 22-27, so the guard also states its line in the unit it counts
// exactly. 1000 rows of budget is 37 schema writes at 27 apiece.
test("the line is also printed in schema writes, which needs no constant", async () => {
  const { stdout } = await runCli("db/migrations 1000\n", { "db/migrations": ONE_TABLE });
  expect(stdout).toContain("exactly: 2 schema writes against a line at 37");
});

test("the schema-write line takes real data rows off the top first", async () => {
  const { stdout } = await runCli("db/migrations 1000\n", {
    "db/migrations": {
      ...ONE_TABLE,
      // Ten real rows, so 990 of the 1000 is left to spend on schema writes.
      "0002_backfill.sql": `INSERT INTO \`a\` (\`id\`) VALUES ${Array.from(
        { length: 10 },
        (_, index) => `('r${index}')`,
      ).join(", ")};`,
    },
  });
  expect(stdout).toContain("exactly: 2 schema writes against a line at 36");
});

test("a chain over its budget exits non-zero and names the figure and the ceiling", async () => {
  const { exitCode, stdout, stderr } = await runCli("db/migrations 100\n", {
    "db/migrations": {
      ...ONE_TABLE,
      // Eight dropped columns, the shape that made the pre-squash chain
      // expensive: eight table rebuilds at two schema writes each.
      "0002_drop.sql": Array.from(
        { length: 8 },
        (_, index) => `ALTER TABLE \`a\` ADD \`c${index}\` text;`,
      )
        .concat(
          Array.from({ length: 8 }, (_, index) => `ALTER TABLE \`a\` DROP COLUMN \`c${index}\`;`),
        )
        .join("\n--> statement-breakpoint\n"),
    },
  });

  expect(exitCode).toBe(1);
  expect(stdout).toContain("8 table-rebuild statement(s)");
  expect(stderr).toContain("::error::");
  // The exact count and line first, then the priced figures.
  expect(stderr).toContain("26 schema writes, over the line at 3");
  expect(stderr).toContain("over the 100 row budget");
  expect(stderr).toContain("100000 rows/day free-tier ceiling");
  expect(stderr).toContain("squash it into a fresh baseline");
});

test("every chain is reported before the run fails, not just the first", async () => {
  const { exitCode, stdout, stderr } = await runCli("db/one 1\ndb/two 1\n", {
    "db/one": ONE_TABLE,
    "db/two": ONE_TABLE,
  });

  expect(exitCode).toBe(1);
  expect(stdout).toContain("db/one:");
  expect(stdout).toContain("db/two:");
  expect(stderr.match(/::error::/g)).toHaveLength(2);
});

test("a chain with no row in the budgets file is an error, not a silent skip", async () => {
  const { exitCode, stderr } = await runCli(
    "db/migrations 1000\n",
    { "db/migrations": ONE_TABLE, "db/other": ONE_TABLE },
    "<root>/db/other",
  );

  expect(exitCode).toBe(1);
  expect(stderr).toContain("no budget recorded for");
});

test("a single chain can be named by path, and only that one runs", async () => {
  const { exitCode, stdout } = await runCli(
    "db/one 1000\ndb/two 1\n",
    { "db/one": ONE_TABLE, "db/two": ONE_TABLE },
    "<root>/db/one",
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("db/one:");
  expect(stdout).not.toContain("db/two:");
});

test("a chain whose directory is missing is an error", async () => {
  const { exitCode, stderr } = await runCli("db/gone 1000\n", {});
  expect(exitCode).toBe(1);
  expect(stderr).toContain("does not exist");
});

test("a chain directory holding no .sql files is an error, not a pass", async () => {
  const { exitCode, stderr } = await runCli("db/migrations 1000\n", {
    "db/migrations": { "README.md": "nothing here" },
  });
  expect(exitCode).toBe(1);
  expect(stderr).toContain("holds no .sql migrations");
});

test("a chain that does not apply fails rather than measuring cheap", async () => {
  const { exitCode, stderr } = await runCli("db/migrations 1000\n", {
    "db/migrations": { "0001_initial.sql": "CREATE INDEX `i` ON `nope` (`id`);" },
  });
  expect(exitCode).toBe(1);
  expect(stderr).toContain("failed to apply");
});

test("a malformed budgets row stops the run rather than being skipped", async () => {
  const { exitCode, stderr } = await runCli("db/migrations\n", { "db/migrations": ONE_TABLE });
  expect(exitCode).toBe(1);
  expect(stderr).toContain("expected '<migrations-dir> <budget-rows-written>'");
});

test("an empty budgets file is a broken config, not a pass", async () => {
  const { exitCode, stderr } = await runCli("# nothing\n", {});
  expect(exitCode).toBe(1);
  expect(stderr).toContain("has no records");
});

test("calling it with no argument is a usage error", async () => {
  const proc = Bun.spawn(["bun", "run", REAL_SCRIPT], { stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("usage:");
});
