import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkOrders } from "../check-migration-orders";

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
