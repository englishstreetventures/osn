#!/usr/bin/env bun
/**
 * Check that a pull request's new migrations apply in every order a database
 * can meet them, and leave the same schema either way.
 *
 * Usage, from the CI script-tests job: `check-migration-orders.ts --base <sha>`,
 * where `<sha>` is the commit the pull request or merge group lands on. It must
 * be present in the clone (`git fetch --depth=1 origin <sha>`); without it the
 * check fails rather than pass on nothing.
 *
 * A migration is named by when it was generated, not when it merged, so one
 * generated before another can merge after it. A database that already holds
 * the base chain (the dev tier, deployed on every merge) then applies the new
 * files after everything else, while a database built from zero, or one that
 * catches up several merges at once (production, in a daily release), applies
 * the whole chain in name order. Both must work, and both must leave the same
 * tables, columns, indexes and foreign keys. Column order is not compared: two
 * columns added to one table land in a different order on the two paths, and
 * nothing here reads columns by position.
 *
 * Imports nothing but Node built-ins and sibling scripts, so the CI job that
 * runs it needs no install.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listMigrations, migrationStatements } from "./migration-files";

/** The directories wrangler applies migrations from. */
export const LIVE_DIRS = [
  "cire/db/migrations",
  "osn/db/drizzle",
  "pulse/db/drizzle",
  "zap/db/drizzle",
];

export type OrderVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function replay(dir: string, files: readonly string[]): Database {
  const db = new Database(":memory:");
  for (const file of files) {
    for (const statement of migrationStatements(readFileSync(join(dir, file), "utf8"))) {
      try {
        db.exec(statement);
      } catch (cause) {
        db.close();
        throw new Error(`${file} does not apply: ${String(cause)}`, { cause });
      }
    }
  }
  return db;
}

/** A column as `pragma_table_info` reports it. */
interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

/** A foreign key as `pragma_foreign_key_list` reports it. */
interface ForeignKeyInfo {
  readonly from: string;
  readonly table: string;
  readonly to: string;
  readonly on_update: string;
  readonly on_delete: string;
}

/**
 * The database's schema as comparable lines, one per table, index, view or
 * trigger: a table by its columns (in name order) and foreign keys, the rest
 * by their SQL.
 */
function schemaLines(db: Database): string[] {
  const objects = db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const lines: string[] = [];
  for (const object of objects) {
    if (object.type !== "table") {
      lines.push(`${object.type} ${object.name}: ${(object.sql ?? "").replaceAll(/\s+/g, " ")}`);
      continue;
    }
    const columns = (
      db
        .query(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`)
        .all(object.name) as ColumnInfo[]
    )
      .map((column) => JSON.stringify(column))
      .toSorted();
    const foreignKeys = (
      db
        .query(`SELECT "from", "table", "to", on_update, on_delete FROM pragma_foreign_key_list(?)`)
        .all(object.name) as ForeignKeyInfo[]
    )
      .map((key) => JSON.stringify(key))
      .toSorted();
    lines.push(`table ${object.name}: ${columns.join(" ")} | ${foreignKeys.join(" ")}`);
  }
  return lines;
}

/** Whether `newFiles` in `dir` apply after the rest, and in name order, to one schema. */
export function checkOrders(dir: string, newFiles: readonly string[]): OrderVerdict {
  if (newFiles.length === 0) return { ok: true };
  const byName = listMigrations(dir);
  const baseFirst = listMigrations(dir, { newLast: newFiles });
  const schemas: string[][] = [];
  for (const [label, order] of [
    ["in name order, as a database built from zero or a daily release applies them", byName],
    ["after the base chain, as the dev tier applies them on merge", baseFirst],
  ] as const) {
    try {
      const db = replay(dir, order);
      schemas.push(schemaLines(db));
      db.close();
    } catch (cause) {
      return { ok: false, reason: `${dir}: applied ${label}, ${(cause as Error).message}` };
    }
  }
  const [nameOrder = [], devOrder = []] = schemas;
  const differ = [
    ...nameOrder.filter((line) => !devOrder.includes(line)),
    ...devOrder.filter((line) => !nameOrder.includes(line)),
  ];
  if (differ.length > 0) {
    return {
      ok: false,
      reason: `${dir}: the two orders leave different schemas (${newFiles.join(", ")} are new):\n  ${differ.join("\n  ")}`,
    };
  }
  return { ok: true };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const base = args[args.indexOf("--base") + 1];
  if (!args.includes("--base") || base === undefined) {
    process.stderr.write("::error::check-migration-orders: pass --base <sha>\n");
    process.exit(1);
  }
  let failed = false;
  for (const dir of LIVE_DIRS) {
    const listed = spawnSync("git", ["ls-tree", "--name-only", base, "--", `${dir}/`], {
      encoding: "utf8",
    });
    if (listed.status !== 0) {
      process.stderr.write(
        `::error::check-migration-orders: cannot read ${dir} at ${base}; fetch the base commit first. ${listed.stderr.trim()}\n`,
      );
      process.exit(1);
    }
    const atBase = new Set(listed.stdout.split("\n").map((path) => path.slice(dir.length + 1)));
    const added = listMigrations(dir).filter((file) => !atBase.has(file));
    const verdict = checkOrders(dir, added);
    if (!verdict.ok) {
      failed = true;
      process.stderr.write(`::error::check-migration-orders: ${verdict.reason}\n`);
    } else {
      process.stdout.write(
        `check-migration-orders: ${dir}: ${added.length} new, both orders agree\n`,
      );
    }
  }
  process.exit(failed ? 1 : 0);
}
