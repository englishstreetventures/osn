import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { ALCHEMY_DIRS, checkOrders, checkSortsLast } from "../check-migration-orders";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-orders-"));
  writeFileSync(
    join(dir, "0001_initial.sql"),
    "CREATE TABLE `t` (`id` text PRIMARY KEY NOT NULL);",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, sql: string) => writeFileSync(join(dir, name), sql);

test("passes when the new files apply in both orders and leave one schema", () => {
  write("20261021000002_on_main.sql", "ALTER TABLE `t` ADD `a` text;");
  write("20261021000001_this_pr.sql", "CREATE TABLE `u` (`id` text PRIMARY KEY NOT NULL);");
  expect(checkOrders(dir, ["20261021000001_this_pr.sql"])).toEqual({ ok: true });
});

test("refuses a pair that applies on a database that had main first, but not from zero", () => {
  // Generated before main's column existed, merged after it: dev applies the
  // column then the index, a fresh or production build applies the index first.
  write("20261021000002_on_main.sql", "ALTER TABLE `t` ADD `c` text;");
  write("20261021000001_this_pr.sql", "CREATE INDEX `t_c` ON `t` (`c`);");
  const result = checkOrders(dir, ["20261021000001_this_pr.sql"]);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toContain("20261021000001_this_pr.sql");
});

test("refuses a pair that fails in both orders, naming the file", () => {
  write("20261021000001_on_main.sql", "ALTER TABLE `t` ADD `c` text;");
  write("20261021000002_this_pr.sql", "ALTER TABLE `t` ADD `c` integer;");
  const result = checkOrders(dir, ["20261021000002_this_pr.sql"]);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toContain("20261021000002_this_pr.sql");
});

test("passes two columns added to one table in either order: only their position differs", () => {
  write("20261021000002_on_main.sql", "ALTER TABLE `t` ADD `a` text;");
  write("20261021000001_this_pr.sql", "ALTER TABLE `t` ADD `b` text;");
  expect(checkOrders(dir, ["20261021000001_this_pr.sql"])).toEqual({ ok: true });
});

test("refuses orders that both apply but leave different schemas", () => {
  write("20261021000002_on_main.sql", "DROP INDEX IF EXISTS `t_x`;");
  write(
    "20261021000001_this_pr.sql",
    "ALTER TABLE `t` ADD `x` text;\n--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS `t_x` ON `t` (`x`);",
  );
  const result = checkOrders(dir, ["20261021000001_this_pr.sql"]);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toContain("t_x");
});

test("has nothing to compare when the pull request adds no migration", () => {
  write("20261021000001_on_main.sql", "ALTER TABLE `t` ADD `a` text;");
  expect(checkOrders(dir, [])).toEqual({ ok: true });
});

// Alchemy migrates every deployed cire, osn and zap database, and refuses a
// pending migration that sorts before one the database already applied.

test("passes new files that sort after every file already on the base", () => {
  write("20261021000001_on_main.sql", "ALTER TABLE `t` ADD `a` text;");
  write("20261021000002_this_pr.sql", "ALTER TABLE `t` ADD `b` text;");
  write("20261021000003_this_pr_too.sql", "ALTER TABLE `t` ADD `c` text;");
  expect(
    checkSortsLast(dir, ["20261021000002_this_pr.sql", "20261021000003_this_pr_too.sql"]),
  ).toEqual({ ok: true });
  expect(checkSortsLast(dir, [])).toEqual({ ok: true });
});

test("refuses every new file that sorts before the base's newest, in the plural", () => {
  write("20261021000003_on_main.sql", "ALTER TABLE `t` ADD `a` text;");
  write("20261021000001_this_pr.sql", "ALTER TABLE `t` ADD `b` text;");
  write("20261021000002_this_pr_too.sql", "ALTER TABLE `t` ADD `c` text;");
  const result = checkSortsLast(dir, [
    "20261021000001_this_pr.sql",
    "20261021000002_this_pr_too.sql",
  ]);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toContain(
    "20261021000001_this_pr.sql, 20261021000002_this_pr_too.sql sort before 20261021000003_on_main.sql",
  );
  expect(!result.ok && result.reason).toContain("rename them");
});

test("passes a directory whose every file is new, as a new database's first migrations are", () => {
  expect(checkSortsLast(dir, ["0001_initial.sql"])).toEqual({ ok: true });
});

test("checks exactly the directories the Alchemy stacks migrate", () => {
  // Each stack's declaration names its source relative to the stack's package.
  const root = join(import.meta.dir, "..", "..");
  const declared = [
    ["cire/infra", "CIRE_DB_MIGRATIONS"],
    ["musubi/infra", "OSN_DB_MIGRATIONS"],
    ["zap/infra", "ZAP_DB_MIGRATIONS"],
  ].map(([stack = "", name = ""]) => {
    const source = readFileSync(join(root, stack, "src/declaration.ts"), "utf8").match(
      new RegExp(`${name}: MigrationSources = \\{ source: "([^"]+)" \\}`),
    )?.[1];
    expect(source).toBeDefined();
    return relative(root, join(root, stack, source ?? ""));
  });
  expect(ALCHEMY_DIRS.toSorted()).toEqual(declared.toSorted());
});

test("refuses a new file that sorts before the base's newest, naming both", () => {
  write("20261021000002_on_main.sql", "ALTER TABLE `t` ADD `a` text;");
  write("20261021000001_this_pr.sql", "ALTER TABLE `t` ADD `b` text;");
  const result = checkSortsLast(dir, ["20261021000001_this_pr.sql"]);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toContain("20261021000001_this_pr.sql");
  expect(!result.ok && result.reason).toContain("20261021000002_on_main.sql");
});

// ── the command, on a real repository ────────────────────────────────────────
// A file found by the base diff is the one replayed last; a diff that found
// none would pass every pull request, so the failing case is the one that
// proves the command reads it.

function repository(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "check-orders-cli-"));
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=o@t", "-c", "user.name=o", ...args], { cwd: root })
      .stdout.toString()
      .trim();
  for (const live of [
    "cire/db/migrations",
    "osn/db/drizzle",
    "pulse/db/drizzle",
    "zap/db/drizzle",
  ]) {
    mkdirSync(join(root, live), { recursive: true });
    writeFileSync(
      join(root, live, "0001_initial.sql"),
      "CREATE TABLE `t` (`id` text PRIMARY KEY NOT NULL);",
    );
  }
  writeFileSync(
    join(root, "cire/db/migrations/20261021000002_on_main.sql"),
    "ALTER TABLE `t` ADD `c` text;",
  );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { root, git };
}

function runCommand(root: string, args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, "run", join(import.meta.dir, "..", "check-migration-orders.ts"), ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

test("the command replays the files added since --base last, and fails one that only works there", () => {
  const { root, git } = repository();
  try {
    const base = git("rev-parse", "HEAD");
    writeFileSync(
      join(root, "cire/db/migrations/20261021000001_this_pr.sql"),
      "CREATE INDEX `t_c` ON `t` (`c`);",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "pull request");
    const result = runCommand(root, ["--base", base]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("20261021000001_this_pr.sql");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command passes a pull request whose new file applies in both orders", () => {
  const { root, git } = repository();
  try {
    const base = git("rev-parse", "HEAD");
    writeFileSync(
      join(root, "osn/db/drizzle/20261021000001_this_pr.sql"),
      "ALTER TABLE `t` ADD `b` text;",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "pull request");
    const result = runCommand(root, ["--base", base]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("osn/db/drizzle: 1 new, both orders agree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command fails a cire, osn or zap file that sorts before the base's newest, though both orders agree", () => {
  const { root, git } = repository();
  try {
    const base = git("rev-parse", "HEAD");
    writeFileSync(
      join(root, "cire/db/migrations/20261021000001_this_pr.sql"),
      "CREATE TABLE `u` (`id` text PRIMARY KEY NOT NULL);",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "pull request");
    const result = runCommand(root, ["--base", base]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("20261021000001_this_pr.sql sorts before");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command leaves pulse, which Alchemy does not migrate, to the order check alone", () => {
  const { root, git } = repository();
  try {
    writeFileSync(
      join(root, "pulse/db/drizzle/20261021000002_on_main.sql"),
      "ALTER TABLE `t` ADD `a` text;",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "pulse on main");
    const base = git("rev-parse", "HEAD");
    writeFileSync(
      join(root, "pulse/db/drizzle/20261021000001_this_pr.sql"),
      "ALTER TABLE `t` ADD `b` text;",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "pull request");
    const result = runCommand(root, ["--base", base]);
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command fails without --base, and on a base it cannot read", () => {
  const { root } = repository();
  try {
    expect(runCommand(root, []).exitCode).toBe(1);
    const unread = runCommand(root, ["--base", "0000000000000000000000000000000000000000"]);
    expect(unread.exitCode).toBe(1);
    expect(unread.output).toContain("fetch the base commit first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
