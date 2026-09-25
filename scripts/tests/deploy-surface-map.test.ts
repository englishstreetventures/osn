import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The deploy workflow's `changes` job redeploys a cire surface only when a push
 * touches a path its `emit` regex names. `shared/` is not mapped per surface
 * (any change there deploys everything), but the cire packages are: each
 * surface's regex lists the `@cire/*` packages it bundles. That list is kept by
 * hand, so a surface that gains a dependency redeploys on nothing it shares
 * until the regex catches up.
 *
 * This holds the map to the package manifests: every `@cire/*` package a
 * surface depends on, directly or through another `@cire/*` package, must be a
 * path its filter matches.
 */

const root = join(import.meta.dir, "..", "..");
const workflow = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");

const filters = new Map<string, RegExp>();
for (const [, output, pattern] of workflow.matchAll(/^\s*emit\s+(\w+)\s+'([^']+)'/gm)) {
  filters.set(output!, new RegExp(pattern!));
}

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

const surfaces = [...filters.keys()].filter((output) => output.startsWith("cire_"));

test("the workflow names cire surfaces, and each is a cire package", () => {
  // Guards the parse above: a regex that matched no `emit` line would make the
  // map test below pass over nothing, and an `emit` line lost or re-quoted
  // would drop its surface out of the check while its deploy jobs still gate
  // on the output.
  const declared = [
    ...workflow.matchAll(/^\s+(cire_\w+): \$\{\{ steps\.filter\.outputs\.\1 \}\}/gm),
  ].map(([, output]) => output!);
  expect(declared.length).toBeGreaterThan(0);
  expect(surfaces.toSorted()).toEqual(declared.toSorted());
  for (const output of surfaces) {
    expect(existsSync(join(root, "cire", output.slice("cire_".length), "package.json"))).toBe(true);
  }
});

const nameByDir = new Map([...cire].map(([name, pkg]) => [pkg.dir, name]));

test.each(surfaces)("%s redeploys when a cire package it bundles changes", (output) => {
  const name = nameByDir.get(`cire/${output.slice("cire_".length)}/`);
  expect(name).toBeDefined();
  const filter = filters.get(output)!;
  const missing = [...bundled(name!)]
    .map((pkg) => cire.get(pkg)?.dir)
    .filter((dir): dir is string => dir !== undefined)
    .filter((dir) => !filter.test(`${dir}package.json`));
  expect(missing).toEqual([]);
});
