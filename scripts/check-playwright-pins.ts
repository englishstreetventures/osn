#!/usr/bin/env bun
/**
 * CI guard: fail if a `playwright`, `@playwright/test`, `vitest` or
 * `@vitest/*` specifier in any workspace is not an exact version, or differs
 * from the others in its group.
 *
 * Two groups, each held to one version across the repo:
 *
 *   - Playwright: `playwright` and `@playwright/test`. Each Playwright version
 *     wants its own Chromium build, and the browser-test and E2E jobs share one
 *     browser cache key, so two versions leave one job downloading its build on
 *     every run.
 *   - Vitest: `vitest` and every `@vitest/*` package. `@vitest/browser`,
 *     `@vitest/browser-playwright`, `@vitest/coverage-istanbul` and
 *     `@vitest/ui` each name an exact `vitest` as a peer, so a caret range that
 *     resolves a newer `vitest` breaks them.
 *
 * Checked in `dependencies`, `devDependencies` and `optionalDependencies` of
 * the root `package.json` and of every workspace. Workspaces are the root's
 * `workspaces` patterns, each expanded to the directories holding a
 * `package.json`.
 */

import { join } from "node:path";

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const GROUPS = [
  {
    name: "playwright",
    matches: (dep: string) => dep === "playwright" || dep === "@playwright/test",
  },
  {
    name: "vitest",
    matches: (dep: string) => dep === "vitest" || dep.startsWith("@vitest/"),
  },
] as const;

export type Finding = {
  readonly workspace: string;
  readonly dependency: string;
  readonly specifier: string;
  readonly problem: string;
};

export type Manifest = {
  readonly workspace: string;
  readonly json: unknown;
};

type Manifestdeps = { readonly [dependency: string]: string };

type Pin = { readonly workspace: string; readonly dependency: string; readonly specifier: string };

function pinsIn({ workspace, json }: Manifest): Pin[] {
  const pins: Pin[] = [];
  for (const field of DEP_FIELDS) {
    const deps = (json as Partial<Record<(typeof DEP_FIELDS)[number], Manifestdeps>> | null)?.[
      field
    ];
    if (deps === undefined || deps === null) continue;
    for (const [dependency, specifier] of Object.entries(deps)) {
      pins.push({ workspace, dependency, specifier: String(specifier) });
    }
  }
  return pins;
}

/** Findings for every pin that is not exact, or that differs from its group's first pin. */
export function checkPlaywrightPins(manifests: readonly Manifest[]): readonly Finding[] {
  const all = manifests.flatMap(pinsIn);
  const findings: Finding[] = [];

  for (const group of GROUPS) {
    const pins = all.filter((pin) => group.matches(pin.dependency));

    for (const pin of pins) {
      if (!EXACT_VERSION.test(pin.specifier)) {
        findings.push({ ...pin, problem: "is not an exact version" });
      }
    }

    const exact = pins.filter((pin) => EXACT_VERSION.test(pin.specifier));
    const versions = [...new Set(exact.map((pin) => pin.specifier))];
    if (versions.length > 1) {
      // The most common version is the one the repo means; the rest drifted.
      const counts = new Map(
        versions.map((v) => [v, exact.filter((p) => p.specifier === v).length]),
      );
      const [expected] = versions.toSorted((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
      for (const pin of exact) {
        if (pin.specifier !== expected) {
          findings.push({
            ...pin,
            problem: `differs from the other ${group.name} pins (${expected})`,
          });
        }
      }
    }
  }

  return findings;
}

const err = (line: string): void => void process.stderr.write(`${line}\n`);
const out = (line: string): void => void process.stdout.write(`${line}\n`);

if (import.meta.main) {
  // Test-only override, the same idiom as check-tests-outside-src.ts. `||`, so
  // an empty value falls back to the repository root.
  const root = Bun.env.PLAYWRIGHT_PINS_ROOT || join(import.meta.dir, "..");

  const rootJson: unknown = await Bun.file(join(root, "package.json")).json();
  const field = (rootJson as { workspaces?: unknown } | null)?.workspaces;
  const patterns = Array.isArray(field)
    ? field
    : (field as { packages?: unknown } | null)?.packages;

  if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === "string")) {
    err(`❌ check-playwright-pins: ${join(root, "package.json")} has no "workspaces" list.`);
    process.exit(1);
  }

  const dirs = new Set<string>();
  for (const pattern of patterns as string[]) {
    for (const manifest of new Bun.Glob(`${pattern}/package.json`).scanSync({
      cwd: root,
      onlyFiles: true,
    })) {
      dirs.add(join(manifest, ".."));
    }
  }
  if (dirs.size === 0) {
    err("❌ check-playwright-pins: the workspace patterns matched no package.json.");
    process.exit(1);
  }

  const loaded = await Promise.all(
    [...dirs].toSorted().map(async (dir): Promise<Manifest> => ({
      workspace: dir,
      json: await Bun.file(join(root, dir, "package.json")).json(),
    })),
  );
  const manifests: Manifest[] = [{ workspace: ".", json: rootJson }, ...loaded];

  const findings = checkPlaywrightPins(manifests);

  if (findings.length > 0) {
    err("❌ check-playwright-pins: a Playwright or Vitest pin broke the pin rule.");
    for (const { workspace, dependency, specifier, problem } of findings) {
      err(`   ${workspace}: ${dependency}@${specifier} — ${problem}`);
    }
    err("");
    err("   Pin every playwright, @playwright/test, vitest and @vitest/* specifier to");
    err("   one exact version per group. See wiki/conventions/contributing.md.");
    process.exit(1);
  }

  out(
    `✅ check-playwright-pins: Playwright and Vitest pins are exact and agree across ${manifests.length} manifests.`,
  );
}
