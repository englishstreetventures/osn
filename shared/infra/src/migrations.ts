import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Data } from "effect";

export class MigrationsSourceError extends Data.TaggedError("MigrationsSourceError")<{
  readonly source: string;
  readonly message: string;
}> {}

/** True when `child` is `parent` or anywhere under it. */
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Copies the top-level *.sql files of `source` into `target` (emptied first) and returns `target`.
 *
 * Alchemy refuses a migrations directory holding Drizzle's `meta/_journal.json`
 * and reads a flat directory of `*.sql` files keyed by name, so the copy keeps
 * every name and byte and leaves out `meta/`, subdirectories and every other
 * file. Emptying the target first means a file an earlier run copied never
 * reaches the next plan. A target that overlaps the source is refused,
 * because emptying it would delete migrations.
 */
export function flattenMigrations(input: {
  readonly source: string;
  readonly target: string;
}): string {
  const source = resolve(input.source);
  const target = resolve(input.target);
  if (within(source, target) || within(target, source)) {
    throw new MigrationsSourceError({
      source: input.source,
      message: `The flattened migrations directory '${input.target}' overlaps the source '${input.source}'; put it outside.`,
    });
  }
  if (!existsSync(source)) {
    throw new MigrationsSourceError({
      source: input.source,
      message: `The migrations directory '${input.source}' does not exist.`,
    });
  }
  const files = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .toSorted();
  if (files.length === 0) {
    throw new MigrationsSourceError({
      source: input.source,
      message: `The migrations directory '${input.source}' holds no top-level .sql file.`,
    });
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of files) copyFileSync(join(source, name), join(target, name));
  return input.target;
}
