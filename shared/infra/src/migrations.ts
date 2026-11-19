import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Data } from "effect";

export class MigrationsSourceError extends Data.TaggedError("MigrationsSourceError")<{
  readonly source: string;
  readonly message: string;
}> {}

/**
 * Where one database's migrations come from. `source` is the directory a new
 * database is built from, the one Wrangler applies locally. `longLived`, for
 * cire's dev and production databases, is the chain every squash after the
 * first moved out of `source`: those two ledgers record each of its files by
 * name and hash, so each is handed over as written, its first in place of
 * `source`'s first (the baseline that replaced it). `archive`, production cire
 * only, is the chain the first squash moved out, whose names production's
 * ledger still holds. `freeze`, production only, adds the generated file that
 * stops Wrangler writing its ledger once Alchemy migrates the database.
 */
export interface MigrationSources {
  readonly source: string;
  readonly longLived?: string;
  readonly archive?: string;
  readonly freeze?: boolean;
}

/** Where a file in the flattened directory comes from. */
export type MigrationFileKind = "live" | "archived" | "generated";

/**
 * One file of the flattened directory: its name, where it comes from, and its
 * text. A `live` file's `path` is the file the directory copies, byte for byte.
 */
export interface MigrationFile {
  readonly name: string;
  readonly kind: MigrationFileKind;
  readonly sql: string;
  readonly path?: string;
}

/**
 * The generated file production's directory holds. Alchemy applies it once,
 * in the release that converts the database's ledger, and from then on any
 * `wrangler d1 migrations apply` against that database fails on the row it
 * inserts into `d1_migrations`, and D1 rolls the whole migration back: an
 * older release run re-run, or an old checkout, cannot apply a file again.
 * Its number, 1000, sorts after every numbered chain (the highest is 0091)
 * and before every timestamped file, so in the conversion release it applies
 * before any file that was waiting, whichever of those fails. Local databases
 * never see it, so the local Wrangler flows, which apply the same files and
 * write their own ledgers, keep working. Its name and bytes never change:
 * Alchemy's ledger records its hash.
 */
export const FREEZE_MIGRATION = {
  name: "1000_freeze_wrangler_ledger.sql",
  sql:
    "-- Production only: Alchemy migrates this database, so Wrangler's ledger takes no new row.\n" +
    "-- Any wrangler d1 migrations apply against it fails on its ledger INSERT and rolls back.\n" +
    'CREATE TRIGGER IF NOT EXISTS "d1_migrations_frozen" BEFORE INSERT ON "d1_migrations"\n' +
    "BEGIN\n" +
    "  SELECT RAISE(ABORT, 'd1_migrations is frozen: the Alchemy stack migrates this database');\n" +
    "END;\n",
};

/**
 * What production's directory holds under an archived name. Production
 * applied every archived file before Alchemy migrated it, so its ledger names
 * each one and Alchemy never runs this. Run, it fails (`no such table`), so a
 * database whose ledger lacks an archived name is refused rather than given
 * the archived SQL (some of which deletes rows or drops columns) or a row
 * saying it was applied. Its bytes never change: Alchemy's ledger records
 * their hash.
 */
export function archivedPlaceholder(name: string): string {
  return (
    `-- ${name} is archived in cire/db/migrations-archive/. Production applied it before Alchemy\n` +
    "-- migrated this database, so its ledger names it and nothing runs this file. Running it\n" +
    "-- means this database's ledger lacks it: refuse, never record it.\n" +
    `SELECT * FROM "${name} was never applied to this database: see cire/db/migrations-archive/README.md";\n`
  );
}

/** The sha256 hex of a migration's text: the hash Alchemy records for it (`@alchemy.run/sql` SqlFile.ts). */
export function migrationHash(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** A file's text as Alchemy reads it: UTF-8, a leading byte-order mark dropped. */
const textOf = (path: string): string => new TextDecoder("utf-8").decode(readFileSync(path));

/** A name's leading number, as Alchemy reads it, or null when it has none. */
const prefixOf = (name: string): number | null => {
  const number = Number.parseInt(name.split("_")[0] ?? "", 10);
  return Number.isNaN(number) ? null : number;
};

/**
 * Alchemy's order for a flat directory (`listSqlFiles`): by leading number,
 * names with one before names without, then by name. The repository's
 * directories hold no two files with one number, so the tie-break never
 * decides; it is by name so the order never depends on the file system.
 */
export function compareMigrationNames(a: string, b: string): number {
  const aNumber = prefixOf(a);
  const bNumber = prefixOf(b);
  if (aNumber !== null && bNumber !== null && aNumber !== bNumber) return aNumber - bNumber;
  if (aNumber !== null && bNumber === null) return -1;
  if (aNumber === null && bNumber !== null) return 1;
  return a.localeCompare(b);
}

/** True when `child` is `parent` or anywhere under it. */
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** The top-level `*.sql` names of `dir` (taken from `from`), refused when it is missing or holds none. */
function sqlNames(from: string, dir: string, label: string): string[] {
  const resolved = resolve(from, dir);
  if (!existsSync(resolved)) {
    throw new MigrationsSourceError({
      source: dir,
      message: `The ${label} directory '${dir}' does not exist.`,
    });
  }
  const names = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .toSorted();
  if (names.length === 0) {
    throw new MigrationsSourceError({
      source: dir,
      message: `The ${label} directory '${dir}' holds no top-level .sql file.`,
    });
  }
  return names;
}

/**
 * Every file the flattened directory for `sources` holds, in Alchemy's order:
 * each top-level `*.sql` file of `longLived` as it is; each top-level `*.sql`
 * file of `source` as it is, but for a name `longLived` holds; for each
 * top-level name of `archive` that neither holds, its refusing placeholder; and
 * with `freeze`, the freeze file. `source`'s first file, its baseline, must
 * carry the name of `longLived`'s first, the baseline it replaced, so the long-lived
 * file takes its place; under another name it would reach dev and production
 * as a new migration, so it is refused. That is the one name the two may
 * share: any other shared name is a moved migration put back, which dev and
 * production would never run while a new database ran it, so it is refused too. Relative paths are taken from `from`,
 * the working directory unless given. Reads the directories; writes nothing.
 */
export function migrationFiles(
  sources: MigrationSources,
  from: string = process.cwd(),
): MigrationFile[] {
  const sourceNames = sqlNames(from, sources.source, "migrations");
  const longLived =
    sources.longLived === undefined
      ? []
      : sqlNames(from, sources.longLived, "long-lived migrations");
  const baseline = sourceNames.toSorted(compareMigrationNames)[0];
  const replaced = longLived.toSorted(compareMigrationNames)[0];
  if (replaced !== undefined && replaced !== baseline) {
    throw new MigrationsSourceError({
      source: sources.source,
      message: `The migrations directory '${sources.source}' starts with ${baseline}, but the long-lived chain '${sources.longLived}' starts with ${replaced}: a baseline under any other name than the one it replaces would reach dev and production as a new migration that builds the whole schema again.`,
    });
  }
  const putBack = longLived.filter((name) => name !== baseline && sourceNames.includes(name));
  if (putBack.length > 0) {
    throw new MigrationsSourceError({
      source: sources.source,
      message: `The migrations directory '${sources.source}' holds ${putBack.join(", ")}, which the long-lived chain '${sources.longLived}' already holds: a squash moved it there, so dev and production would never run it. Give the change a new migration instead.`,
    });
  }
  const liveFile = (dir: string, name: string): MigrationFile => {
    const path = join(resolve(from, dir), name);
    return { name, kind: "live", sql: textOf(path), path };
  };
  const live = [
    ...longLived.map((name) => liveFile(sources.longLived!, name)),
    ...sourceNames
      .filter((name) => !longLived.includes(name))
      .map((name) => liveFile(sources.source, name)),
  ];
  const held = new Set(live.map((file) => file.name));
  const archived =
    sources.archive === undefined
      ? []
      : sqlNames(from, sources.archive, "archived migrations").filter((name) => !held.has(name));
  const files: MigrationFile[] = [
    ...live,
    ...archived.map((name): MigrationFile => ({
      name,
      kind: "archived",
      sql: archivedPlaceholder(name),
    })),
    ...(sources.freeze === true
      ? [{ name: FREEZE_MIGRATION.name, kind: "generated" as const, sql: FREEZE_MIGRATION.sql }]
      : []),
  ];
  return files.toSorted((a, b) => compareMigrationNames(a.name, b.name));
}

/**
 * Writes the directory Alchemy migrates a database from into `target`
 * (emptied first) and returns `target`.
 *
 * Wrangler applies only the `*.sql` files directly in a migrations directory
 * (`scripts/migration-files.ts`). Alchemy also applies `*.sql` files in its
 * subdirectories and refuses a directory holding drizzle-kit's old
 * `meta/_journal.json`, so the copy keeps every top-level name and byte of
 * `source` and leaves out subdirectories and every other file: Alchemy applies
 * exactly the files Wrangler would, under the names Wrangler's ledger records.
 * On production, `archive` adds a refusing placeholder under each archived
 * name and `freeze` the freeze file (`migrationFiles`), so the names a
 * production ledger holds all match a file. Emptying the target first means a
 * file an earlier run wrote never reaches the next plan. A target that
 * overlaps a source is refused, because emptying it would delete migrations.
 * Every directory is checked before the target is touched. Relative paths are
 * taken from `from`, the working directory unless given.
 */
export function flattenMigrations(
  input: MigrationSources & { readonly target: string },
  from: string = process.cwd(),
): string {
  const target = resolve(from, input.target);
  for (const dir of [input.source, input.longLived, input.archive]) {
    if (dir === undefined) continue;
    const source = resolve(from, dir);
    if (within(source, target) || within(target, source)) {
      throw new MigrationsSourceError({
        source: dir,
        message: `The flattened migrations directory '${input.target}' overlaps the source '${dir}'; put it outside.`,
      });
    }
  }
  const files = migrationFiles(input, from);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    if (file.kind === "live" && file.path !== undefined)
      copyFileSync(file.path, join(target, file.name));
    else writeFileSync(join(target, file.name), file.sql);
  }
  return input.target;
}
