import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SURFACES } from "../deploy-surfaces";

/*
 * Both deploy workflows redeploy a cire surface only when a change touches a
 * path its regex in scripts/deploy-surfaces.ts names. `shared/` is not mapped
 * per surface (any change there deploys everything), but the cire packages
 * are: each surface's regex lists the `@cire/*` packages it bundles. That list
 * is kept by hand, so a surface that gains a dependency redeploys on nothing
 * it shares until the regex catches up.
 *
 * This holds the map to the package manifests: every `@cire/*` package a
 * surface depends on, directly or through another `@cire/*` package, must be a
 * path its filter matches.
 */

const root = join(import.meta.dir, "..", "..");

const filters = new Map(SURFACES.map((s) => [s.key, s.paths]));

interface CirePackage {
  dir: string;
  deps: string[];
}

const cire = new Map<string, CirePackage>();
for (const entry of readdirSync(join(root, "cire"), { withFileTypes: true })) {
  const manifest = join(root, "cire", entry.name, "package.json");
  if (!entry.isDirectory() || !existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  cire.set(pkg.name, {
    dir: `cire/${entry.name}/`,
    deps: deps.filter((name) => name.startsWith("@cire/")),
  });
}

/** The directories of every `@cire/*` package `name` bundles, itself included. */
function bundled(name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const dep of cire.get(name)?.deps ?? []) bundled(dep, seen);
  return seen;
}

const surfaces = [...filters.keys()].filter((key) => key.startsWith("cire_"));

test("the map names cire surfaces, and each is a cire package", () => {
  // Guards the loop below: an empty list would make it pass over nothing.
  // That the workflows gate on exactly these keys is
  // scripts/tests/deploy-workflows.test.ts's job.
  expect(surfaces.length).toBeGreaterThan(0);
  for (const key of surfaces) {
    expect(existsSync(join(root, "cire", key.slice("cire_".length), "package.json"))).toBe(true);
  }
});

const nameByDir = new Map([...cire].map(([name, pkg]) => [pkg.dir, name]));

test.each(surfaces)("%s redeploys when a cire package it bundles changes", (key) => {
  const name = nameByDir.get(`cire/${key.slice("cire_".length)}/`);
  expect(name).toBeDefined();
  const filter = filters.get(key)!;
  const missing = [...bundled(name!)]
    .map((pkg) => cire.get(pkg)?.dir)
    .filter((dir): dir is string => dir !== undefined)
    .filter((dir) => !filter.test(`${dir}package.json`));
  expect(missing).toEqual([]);
});
