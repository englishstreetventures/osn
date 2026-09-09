#!/usr/bin/env bun
/**
 * Lint guard: fail if any Astro app has a routable test file under `src/pages`.
 *
 * Astro routes every file under `src/pages` into a live page, EXCEPT one whose
 * name (or an ancestor directory's name, anywhere between `src/pages` and the
 * file) starts with `_` — that is the one prefix its router treats as private.
 * A `*.test.ts`/`*.spec.ts` left un-prefixed there is therefore built and
 * deployed as a real route, not skipped as "just a test file". Measured:
 * exactly this happened to cire/invites — three drift-guard tests sat
 * un-prefixed under `src/pages`, got routed, and dragged 119 KB gzip of vitest
 * into the deployed Worker. The general half of that finding is
 * this: any of the six Astro apps can make the same mistake, and it costs
 * nothing to check for on every commit — no build, no baseline, just a
 * directory walk.
 *
 * Wired into the fast `lint` job in ci.yml, not `build-test`: it needs no
 * `astro build` and nothing app-specific, so there is no reason to wait on the
 * slower job for it.
 */

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const TEST_ROUTE = /\.(?:test|spec)\./;

export async function findTestRoutes(pagesDir: string): Promise<readonly string[]> {
  const violations: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // No src/pages at all (or unreadable) is not this guard's problem.
      return;
    }

    for (const entry of entries) {
      // A `_`-prefixed name, file or directory, is exactly what Astro's own
      // router excludes — walking past it would flag files Astro never routes.
      if (entry.name.startsWith("_")) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && TEST_ROUTE.test(entry.name)) {
        violations.push(full);
      }
    }
  }

  await walk(pagesDir);
  return violations;
}

// The six Astro apps in the repo (grep -n 'output:' */*/astro.config.mjs).
// musubi/social also has a src/pages directory, but it holds plain component
// files read by a client-side router, not an Astro app — there is no
// astro.config.mjs there, and Astro's src/pages routing rule does not apply.
const DEFAULT_ASTRO_APPS = [
  "cire/invites",
  "cire/host",
  "cire/vendor",
  "cire/landing",
  "musubi/landing",
  "pulse/landing",
] as const;

// Test-only override, the same idiom as check-d1-database-id.ts's
// WRANGLER_TOML: a comma-separated list of app roots, so the CLI test can
// point this at fixture directories instead of the real repo. An absolute
// entry (what a fixture's mkdtemp root is) is used as-is; a relative one
// resolves the same way the default list does, against the repo root.
const ASTRO_APPS = Bun.env.ASTRO_TEST_ROUTE_APPS?.split(",").filter(Boolean) ?? DEFAULT_ASTRO_APPS;

function resolvePagesDir(app: string): string {
  return isAbsolute(app)
    ? join(app, "src/pages")
    : new URL(`../${app}/src/pages`, import.meta.url).pathname;
}

// `findTestRoutes` itself treats an unreadable/missing `pagesDir` as nothing
// to check (see its own comment) — deliberately, since that keeps it simple
// for a caller that already knows a directory might legitimately not exist.
// But every app named in ASTRO_APPS is a real, committed Astro app, and all
// six have a `src/pages` today: a missing one here is never a legitimate
// state, only a bug — a wrong path in this file, a moved app, or (the case
// the reviewer reproduced) a `scripts/` reorganisation that breaks
// `resolvePagesDir`'s relative join. Silently finding zero routes and
// printing the success line is exactly the vacuous-pass failure mode this
// whole guard exists to prevent, so this is checked explicitly and fails
// closed — a `src/pages` that exists and is merely empty still passes.
async function pagesDirIsMissing(pagesDir: string): Promise<boolean> {
  try {
    return !(await stat(pagesDir)).isDirectory();
  } catch {
    return true;
  }
}

if (import.meta.main) {
  // ASTRO_TEST_ROUTE_APPS is `?? DEFAULT_ASTRO_APPS`, which only falls back on
  // undefined/null — set to "" (or anything `.filter(Boolean)` reduces to
  // nothing), ASTRO_APPS becomes `[]`, the loop below never runs, `failed`
  // stays false, and the success banner prints having checked zero apps. That
  // is the same vacuous-pass failure `pagesDirIsMissing` above exists to
  // close, just reachable through the app LIST instead of one app's path.
  // Production (ci.yml) never sets the env var, so DEFAULT_ASTRO_APPS (6
  // apps) always applies there; this only guards the test-only override.
  if (ASTRO_APPS.length === 0) {
    console.error(
      "::error::check-astro-test-routes: ASTRO_APPS resolved to an empty list — checking zero apps and printing success would be a vacuous pass, not a clean run.",
    );
    process.exit(1);
  }

  let failed = false;

  for (const app of ASTRO_APPS) {
    const pagesDir = resolvePagesDir(app);

    if (await pagesDirIsMissing(pagesDir)) {
      failed = true;
      console.error(
        `::error::check-astro-test-routes: ${app}'s src/pages does not exist at ${pagesDir} — every configured Astro app must have one. If ${app} was renamed, removed, or scripts/ itself moved, fix ASTRO_APPS in scripts/check-astro-test-routes.ts rather than let this pass silently.`,
      );
      continue;
    }

    const violations = await findTestRoutes(pagesDir);

    for (const violation of violations) {
      failed = true;
      const rel = relative(pagesDir, violation);
      console.error(
        `::error::${app}/src/pages/${rel} is a *.test.*/*.spec.* file with no \`_\` prefix — Astro routes it as a live page and ships it in the deployed bundle (this cost cire/invites' Worker 119 KB gzip). Prefix the file, or an ancestor directory, with \`_\` to exclude it from routing, or move it out of src/pages entirely.`,
      );
    }
  }

  if (failed) process.exit(1);
  console.log(
    "✅ check-astro-test-routes: no *.test.*/*.spec.* files routed under any app's src/pages.",
  );
}
