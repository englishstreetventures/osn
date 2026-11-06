#!/usr/bin/env bun
/**
 * CI guard: fail on a literal motion value in a product stylesheet or Astro
 * file.
 *
 * `house/no-literal-motion` reports a written duration, delay or easing in
 * TypeScript and JavaScript. oxlint never parses `.css`, and `oxlintrc.json`
 * ignores `*.astro` (oxlint would read only an Astro file's frontmatter and
 * `<script>`), so this script is the same check for those files: every `.css`
 * file, and every `.astro` file's `<style>` blocks, markup classes, `style`
 * attributes, frontmatter and `<script>` classes, under `<product>/*\/src/`
 * for each product directory below. What counts as a literal, and the
 * `motion-literal:` marker that keeps one with its reason, live in
 * `scripts/lib/motion-literals.ts`, which the lint rule imports too.
 *
 * Wired into the `script-tests` job in ci.yml: a directory walk, with no build
 * and no install. Its tests, scripts/tests/check-motion-literals.test.ts, run
 * in "Test the scripts" there.
 */

import { join, relative } from "node:path";

import { checkAstro, checkCss, formatLiterals, MOTION_ADVICE } from "./lib/motion-literals";

/** The product trees; `tools/` and `scripts/` are not shipped. */
const PRODUCTS = ["osn", "musubi", "pulse", "cire", "shared", "zap"] as const;

/** The `.css` and `.astro` files under each product package's `src/`, relative to `root`, sorted. */
function sourceFiles(root: string): string[] {
  const glob = new Bun.Glob(`{${PRODUCTS.join(",")}}/*/src/**/*.{css,astro}`);
  return [...glob.scanSync({ cwd: root, onlyFiles: true })]
    .filter((path) => !path.split("/").includes("node_modules"))
    .toSorted();
}

if (import.meta.main) {
  // Test-only override, the idiom of check-tests-outside-src.ts. `||`, so an
  // empty value falls back to the repository root.
  const root = Bun.env.MOTION_LITERALS_ROOT || join(import.meta.dir, "..");
  const files = sourceFiles(root);

  if (files.length === 0) {
    process.stderr.write(
      `::error::check-motion-literals: no .css or .astro file under any of ${PRODUCTS.map((p) => `${p}/*/src/`).join(", ")} in ${root}. Checking nothing and printing success would be a pass that proves nothing.\n`,
    );
    process.exit(1);
  }

  const texts = await Promise.all(files.map((path) => Bun.file(join(root, path)).text()));

  let failed = false;
  for (const [i, path] of files.entries()) {
    const text = texts[i] ?? "";
    const findings = path.endsWith(".astro") ? checkAstro(text) : checkCss(text);
    for (const finding of findings) {
      failed = true;
      const rel = relative(root, join(root, path));
      process.stderr.write(
        `::error file=${rel},line=${finding.line}::\`${finding.text}\` writes ${formatLiterals(finding.literals)}. ${MOTION_ADVICE}\n`,
      );
    }
  }

  if (failed) process.exit(1);
  process.stdout.write(
    `check-motion-literals: no literal motion in ${files.length} stylesheets and Astro files.\n`,
  );
}
