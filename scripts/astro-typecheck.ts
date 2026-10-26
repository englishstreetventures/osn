/**
 * An Astro site's `typecheck`: `tsc -p . --runExternalCode`, run once with
 * `--listFiles`, which type-checks the site and prints every file the program
 * loaded. The file list is checked here and the rest of the output passed
 * through.
 *
 * `.astro` files are checked only while the site's tsconfig registers the
 * content mapper. Without it `tsc` exits 0 having loaded no `.astro` file at
 * all, so a dropped or mistyped `contentMappers` entry fails nothing else; this
 * fails when an `.astro` file under `src/` is missing from the program.
 *
 * Plain `node_modules/.bin/tsc`, never `bunx --bun`: the mapper starts as
 * `node dist/server.js`, and CI pins the Node it runs on.
 *
 * Run from the site's directory: `bun ../../scripts/astro-typecheck.ts`.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The `.astro` files under `src/` that the program does not load. */
export function uncheckedAstroFiles(
  astroFiles: readonly string[],
  programFiles: readonly string[],
): string[] {
  const loaded = new Set(programFiles);
  return astroFiles.filter((file) => !loaded.has(file));
}

if (import.meta.main) {
  const site = process.cwd();
  const pretty = process.stdout.isTTY ? ["--pretty"] : [];
  const run = Bun.spawnSync(
    [
      join(site, "node_modules/.bin/tsc"),
      "-p",
      site,
      "--runExternalCode",
      "--listFiles",
      ...pretty,
    ],
    { cwd: site, stderr: "inherit" },
  );

  // `--listFiles` prints each loaded file as an absolute path on a line of its
  // own; diagnostics name files relative to the site and never start a line
  // with `/`.
  const lines = run.stdout.toString().split("\n");
  const loaded = lines.filter((line) => line.startsWith("/"));
  const report = lines.filter((line) => !line.startsWith("/")).join("\n");
  if (report.trim()) process.stdout.write(`${report.trimEnd()}\n`);
  if (run.exitCode !== 0) process.exit(run.exitCode ?? 1);

  const src = join(site, "src");
  const astro = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".astro"))
    .map((path) => join(src, path));
  const missing = uncheckedAstroFiles(astro, loaded);
  if (astro.length === 0 || missing.length > 0) {
    const say = (line: string) => process.stderr.write(`${line}\n`);
    say(
      `astro-typecheck: ${astro.length - missing.length} of ${astro.length} .astro files under src/ were type-checked.`,
    );
    for (const file of missing) say(`   not checked: ${file.slice(site.length + 1)}`);
    say(
      '   Register the mapper in tsconfig.json: "contentMappers": [{ "package": "@astrojs/ts-content-mapper", "extensions": [".astro"] }]',
    );
    process.exit(1);
  }
}
