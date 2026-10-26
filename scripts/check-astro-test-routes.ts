#!/usr/bin/env bun
/**
 * Lint guard: fail if any Astro app has a test, spec or fixture under `src/pages`
 * that Astro would route.
 *
 * Astro routes every file under `src/pages` into a live page, EXCEPT one whose
 * name (or an ancestor directory's name, anywhere between `src/pages` and the
 * file) starts with `_` — that is the one prefix its router treats as private.
 * A `*.test.ts`/`*.spec.ts` or a fixture left un-prefixed there is therefore
 * built and deployed as a real route, not skipped as "just a test file".
 *
 * A name matches when it contains `.test.` or `.spec.`, or the word `fixture`
 * in any case (`fixtures.ts`, `invite.fixture.ts`, `InviteFixture.ts`). The
 * same test applies to directory names, since every file under an un-prefixed
 * `fixtures/` is routed whatever it is called; a matching directory is
 * reported once and not walked further. Any un-prefixed symlink is refused
 * outright: Astro follows it and routes what it points at, whatever that is
 * called, and no app has one today. Measured:
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
import { basename, isAbsolute, join, relative } from "node:path";

const TEST_ROUTE = /\.(?:test|spec)\.|fixture/i;
const TEST_OR_SPEC = /\.(?:test|spec)\./i;

export interface TestRoute {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
}

export async function findTestRoutes(pagesDir: string): Promise<readonly TestRoute[]> {
  async function walk(dir: string): Promise<TestRoute[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // No src/pages at all (or unreadable) is not this guard's problem.
      return [];
    }

    const nested = await Promise.all(
      entries.map(async (entry): Promise<TestRoute[]> => {
        // A `_`-prefixed name, file or directory, is exactly what Astro's own
        // router excludes — walking past it would flag files Astro never routes.
        if (entry.name.startsWith("_")) return [];

        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) return [{ path, kind: "symlink" }];
        if (entry.isDirectory()) {
          return TEST_ROUTE.test(entry.name) ? [{ path, kind: "directory" }] : walk(path);
        }
        return entry.isFile() && TEST_ROUTE.test(entry.name) ? [{ path, kind: "file" }] : [];
      }),
    );
    return nested.flat();
  }

  return (await walk(pagesDir)).toSorted((a, b) => a.path.localeCompare(b.path));
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
    process.stderr.write(
      "::error::check-astro-test-routes: ASTRO_APPS resolved to an empty list — checking zero apps and printing success would be a vacuous pass, not a clean run.\n",
    );
    process.exit(1);
  }

  // Every app is walked at once; the report below keeps ASTRO_APPS' order.
  const results = await Promise.all(
    ASTRO_APPS.map(async (app) => {
      const pagesDir = resolvePagesDir(app);
      const violations = (await pagesDirIsMissing(pagesDir))
        ? undefined
        : await findTestRoutes(pagesDir);
      return { app, pagesDir, violations };
    }),
  );

  let failed = false;

  for (const { app, pagesDir, violations } of results) {
    if (violations === undefined) {
      failed = true;
      process.stderr.write(
        `::error::check-astro-test-routes: ${app}'s src/pages does not exist at ${pagesDir} — every configured Astro app must have one. If ${app} was renamed, removed, or scripts/ itself moved, fix ASTRO_APPS in scripts/check-astro-test-routes.ts rather than let this pass silently.\n`,
      );
      continue;
    }

    for (const { path, kind } of violations) {
      failed = true;
      const rel = relative(pagesDir, path) + (kind === "directory" ? "/" : "");
      // A `_` prefix satisfies this check, but check-tests-outside-src.ts,
      // the next step in the same CI job, refuses any symlink and any test or
      // spec file under src/ whatever its prefix. Those two get advice that
      // passes both checks.
      const routed =
        "Astro routes page and endpoint files under src/pages as live routes and ships them in the deployed bundle (a routed test cost cire/invites' Worker 119 KB gzip).";
      const message =
        kind === "symlink"
          ? "is a symlink with no `_` prefix. Astro follows it and routes whatever it points at, which this check cannot see. Replace it with the file or directory it points at. A `_` prefix does not help: check-tests-outside-src.ts refuses any symlink under src/."
          : kind === "file" && TEST_OR_SPEC.test(basename(path))
            ? `is named like a test or spec file and has no \`_\` prefix. ${routed} Rename it if it is a real page; otherwise move it to the package's tests/ directory, mirroring src/. A \`_\` prefix does not help: check-tests-outside-src.ts refuses a test file anywhere under src/.`
            : `is named like a test, spec or fixture ${kind} and has no \`_\` prefix. ${routed} Rename it if it is a real page, prefix it (or an ancestor directory) with \`_\` to exclude it from routing, or move it out of src/pages.`;
      process.stderr.write(`::error::${app}/src/pages/${rel} ${message}\n`);
    }
  }

  if (failed) process.exit(1);
  process.stdout.write(
    "✅ check-astro-test-routes: no test, spec or fixture files routed under any app's src/pages.\n",
  );
}
