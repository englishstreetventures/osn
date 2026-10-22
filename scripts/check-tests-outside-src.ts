#!/usr/bin/env bun
/**
 * Lint guard: fail if any workspace has a test or spec file under its `src/`.
 *
 * Tests live in `tests/` at the package root, mirroring `src/` (AGENTS.md
 * §Standing rules). A test left under `src/` breaks that rule in one of two
 * ways, and neither turns a check red on its own. Where a Vitest project has
 * no `include` (cire/invites' `unit`), the file is collected and passes, and
 * the rule is broken without anyone noticing. Where a project includes only
 * `tests/**` (cire/invites' `browser` and `ssr`), a `src/**\/*.browser.test.tsx`
 * runs in no project at all: it reads as coverage in review and tests nothing.
 *
 * A file fails when its name contains `.test.`, `.spec.`, `_test.` or
 * `_spec.`, in any case and with any extension: Vitest collects the dotted
 * forms and `bun test` all four, and three workspaces run a bare `bun test`
 * that takes no directory. Any symlink under `src/` fails too, because the
 * walk does not follow it and so cannot see what sits behind it.
 *
 * Workspaces are the root package.json's `workspaces` patterns (a list, or an
 * object whose `packages` is one), each expanded to the directories holding a
 * `package.json`. The scan does not follow a symlinked workspace directory;
 * there is none. A pattern starting with `!` is refused rather than expanded:
 * `Bun.Glob` reads it as a negation, which would match package.json files
 * across the whole tree. A workspace with no `src/` has nothing to check.
 *
 * Wired into the fast `lint` job in ci.yml beside check-astro-test-routes.ts:
 * a directory walk, with no build and no install.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const TEST_FILE = /[._](?:test|spec)\./i;

interface Violation {
  readonly path: string;
  readonly kind: "file" | "symlink";
}

/** Test-named files and symlinks under `srcDir`, sorted; `[]` when it does not exist. */
async function findTestsUnderSrc(srcDir: string): Promise<readonly Violation[]> {
  async function walk(dir: string): Promise<Violation[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // No src/ is a workspace with nothing to check; anything else fails closed.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && dir === srcDir) return [];
      throw err;
    }

    const nested = await Promise.all(
      entries.map(async (entry): Promise<Violation[]> => {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) return [{ path, kind: "symlink" }];
        if (entry.isDirectory()) return walk(path);
        return TEST_FILE.test(entry.name) ? [{ path, kind: "file" }] : [];
      }),
    );
    return nested.flat();
  }

  return (await walk(srcDir)).toSorted((a, b) => a.path.localeCompare(b.path));
}

type Patterns =
  | { readonly ok: true; readonly patterns: readonly string[] }
  | { readonly ok: false };

function workspacePatterns(manifest: unknown): Patterns {
  const field = (manifest as { workspaces?: unknown } | null)?.workspaces;
  const list = Array.isArray(field) ? field : (field as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(list) || !list.every((p) => typeof p === "string")) return { ok: false };
  return { ok: true, patterns: list };
}

/** Workspace directories relative to `root`, sorted. */
function expandWorkspaces(root: string, patterns: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for (const manifest of glob.scanSync({ cwd: root, onlyFiles: true })) {
      dirs.add(join(manifest, ".."));
    }
  }
  return [...dirs].toSorted();
}

function fail(message: string): never {
  process.stderr.write(`::error::check-tests-outside-src: ${message}\n`);
  process.exit(1);
}

if (import.meta.main) {
  // Test-only override, the same idiom as check-astro-test-routes.ts's
  // ASTRO_TEST_ROUTE_APPS. `||`, so an empty value falls back to the
  // repository root rather than resolving against the working directory.
  const root = Bun.env.TESTS_OUTSIDE_SRC_ROOT || join(import.meta.dir, "..");

  const read = workspacePatterns(await Bun.file(join(root, "package.json")).json());
  if (!read.ok) {
    fail(
      `${join(root, "package.json")} has no "workspaces" list (or "workspaces.packages" list) of patterns to check.`,
    );
  }
  const negated = read.patterns.filter((p) => p.startsWith("!"));
  if (negated.length > 0) {
    fail(
      `negated workspace patterns (${negated.join(", ")}) are not supported: expanding one would match package.json files across the whole tree. Teach scripts/check-tests-outside-src.ts to subtract them before adding one.`,
    );
  }

  const workspaces = expandWorkspaces(root, read.patterns);
  if (workspaces.length === 0) {
    fail(
      `the workspace patterns (${read.patterns.join(", ")}) matched no directory holding a package.json. Checking zero workspaces and printing success would be a pass that proves nothing.`,
    );
  }

  const found = await Promise.all(
    workspaces.map((workspace) => findTestsUnderSrc(join(root, workspace, "src"))),
  );

  let failed = false;
  for (const [i, workspace] of workspaces.entries()) {
    const srcDir = join(root, workspace, "src");
    for (const { path, kind } of found[i] ?? []) {
      failed = true;
      const rel = relative(root, path);
      const message =
        kind === "symlink"
          ? `${rel} is a symlink under src/. This check does not follow links, so it cannot see whether a test sits behind one. Replace the link with what it points at.`
          : `${rel} is a test file under src/. Tests live in tests/ at the package root, mirroring src/: move it to ${join(workspace, "tests", relative(srcDir, path))}.`;
      process.stderr.write(`::error file=${rel}::${message}\n`);
    }
  }

  if (failed) process.exit(1);
  process.stdout.write(
    `check-tests-outside-src: no test or spec file under src/ in ${workspaces.length} workspaces.\n`,
  );
}
