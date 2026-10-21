/**
 * The migration files of a D1 database, as wrangler sees them.
 *
 * Every `migrations_dir` here holds flat `.sql` files and nothing wrangler
 * should apply besides: the numbered chain (`0001_…`, `0090_…`) and, after it,
 * files named by their UTC creation time (`20261021031500_…`). Wrangler's
 * default pattern is `<dir>/*.sql`, and it orders files by their leading
 * number, then by name (`compareMigrationPaths` in wrangler's CLI), so a
 * timestamped file sorts after every numbered one. Each replay, guard and
 * check in this repository lists migrations through here, so none of them can
 * disagree with the order a deployed database applies them in.
 *
 * Imports nothing but Node built-ins, so the CI jobs that run scripts without
 * an install can use it.
 */

import { readdirSync } from "node:fs";

/** A file's leading number, as wrangler reads it, or NaN when it has none. */
const leadingNumber = (name: string): number => Number.parseInt(name.split("_")[0] ?? "", 10);

function compareMigrationNames(a: string, b: string): number {
  const aNumber = leadingNumber(a);
  const bNumber = leadingNumber(b);
  if (aNumber !== bNumber) {
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
    if (Number.isFinite(aNumber)) return -1;
    if (Number.isFinite(bNumber)) return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ListOptions {
  /**
   * Files to apply last, in name order, after everything else in name order:
   * the order a database meets them in when it already holds the rest. A name
   * the directory does not hold is an error, never silently dropped.
   */
  readonly newLast?: readonly string[];
}

/** The `.sql` files directly in `dir`, in the order wrangler applies them. */
export function listMigrations(dir: string, options: ListOptions = {}): string[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .toSorted(compareMigrationNames);
  const last = new Set(options.newLast ?? []);
  const missing = [...last].filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`${dir} holds no migration named ${missing.join(", ")}`);
  }
  return [...names.filter((name) => !last.has(name)), ...names.filter((name) => last.has(name))];
}

/**
 * The statements of a migration file, one per `--> statement-breakpoint`, with
 * whole comment lines dropped. A file of comments alone yields none: bun:sqlite
 * refuses to run SQL that holds no statement, so a replay must skip it, and a
 * guard can tell such a file from a real migration.
 */
export function migrationStatements(sql: string): readonly string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}
