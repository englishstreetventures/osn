/**
 * Each Astro site's `typecheck` is `tsc -p . --runExternalCode`, and it checks
 * `.astro` files only while the site's tsconfig registers the content mapper.
 * Without it `tsc` exits 0 having loaded no `.astro` file at all, so a dropped
 * or mistyped `contentMappers` entry fails nothing else. This lists each site's
 * program and fails when an `.astro` file under its `src/` is missing from it.
 *
 * Needs the install (each site's `node_modules/.bin/tsc`), so CI runs it in the
 * `typecheck` job, not beside the install-free script tests.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

export const ASTRO_SITES = [
  "cire/host",
  "cire/invites",
  "cire/landing",
  "cire/vendor",
  "musubi/landing",
  "pulse/landing",
] as const;

/** The `.astro` files under `src/` that the program does not load. */
export function uncheckedAstroFiles(
  astroFiles: readonly string[],
  programFiles: readonly string[],
): string[] {
  const loaded = new Set(programFiles);
  return astroFiles.filter((file) => !loaded.has(file));
}

const say = (line: string) => process.stderr.write(`${line}\n`);

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  let failed = false;
  for (const site of ASTRO_SITES) {
    const dir = join(root, site);
    const src = join(dir, "src");
    const astro = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".astro"))
      .map((path) => join(src, path));
    const run = Bun.spawnSync(
      [join(dir, "node_modules/.bin/tsc"), "-p", dir, "--runExternalCode", "--listFilesOnly"],
      { cwd: dir },
    );
    if (run.exitCode !== 0) {
      say(`❌ check-astro-typecheck: ${site}: tsc --listFilesOnly failed`);
      say(run.stderr.toString());
      failed = true;
      continue;
    }
    const missing = uncheckedAstroFiles(astro, run.stdout.toString().split("\n"));
    if (astro.length === 0 || missing.length > 0) {
      say(
        `❌ check-astro-typecheck: ${site} type-checks ${astro.length - missing.length} of ${astro.length} .astro files.`,
      );
      for (const file of missing) say(`   not checked: ${file.slice(root.length)}`);
      say(
        '   Register the mapper in its tsconfig.json: "contentMappers": [{ "package": "@astrojs/ts-content-mapper", "extensions": [".astro"] }]',
      );
      failed = true;
    }
  }
  if (failed) process.exit(1);
  process.stdout.write(
    `✅ check-astro-typecheck: ${ASTRO_SITES.length} sites type-check every .astro file.\n`,
  );
}
