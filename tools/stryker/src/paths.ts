/**
 * Path work for `test:mutation`: turning what a person types from a package
 * into the repo-root paths Stryker reads, and a branch's diff into line ranges.
 */

import { isAbsolute, join, relative } from "node:path";

const MUTABLE = /\/src\/.*\.tsx?$/;
const NOT_MUTABLE = /\.d\.ts$|\.(test|spec)\.tsx?$/;

/**
 * One `--mutate` entry as a repo-root path, keeping a `:line-range` suffix and
 * a leading `!` (Stryker's exclusion) in place. A package-relative entry is
 * prefixed with `pkgDir`, an absolute one is made relative to `repoRoot`, and
 * one already starting with `pkgDir/` is left alone.
 */
export function rootMutateEntry(entry: string, pkgDir: string, repoRoot: string): string {
  const negated = entry.startsWith("!");
  const path = negated ? entry.slice(1) : entry;
  const rooted = isAbsolute(path)
    ? relative(repoRoot, path)
    : path.startsWith(`${pkgDir}/`)
      ? path
      : join(pkgDir, path);
  return negated ? `!${rooted}` : rooted;
}

/**
 * Parses one `--mutate` entry: trimmed, and refused when empty. Stryker
 * matches the text literally, so a blank entry would match no file and the run
 * would mutate nothing and exit 0.
 */
export function parseMutateEntry(input: string): string {
  const entry = input.trim();
  if (entry === "" || entry === "!") throw new SyntaxError("a --mutate entry is empty");
  return entry;
}

/**
 * Turns `git diff -U0` output and a list of untracked files into `--mutate`
 * entries: one `path:start-end` per added or changed hunk, and the whole file
 * for an untracked one. Only source under `src/` is kept — no declaration
 * files and no tests. A hunk that only deletes lines has nothing to mutate.
 */
export function changedMutate(diff: string, untracked: readonly string[]): string[] {
  const keep = (path: string) => MUTABLE.test(path) && !NOT_MUTABLE.test(path);
  const entries: string[] = [];
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      file = path.startsWith("b/") && keep(path.slice(2)) ? path.slice(2) : undefined;
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!file || !hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) entries.push(`${file}:${start}-${start + count - 1}`);
  }
  return [...entries, ...untracked.filter(keep)];
}
