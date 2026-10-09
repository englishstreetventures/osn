// @vitest-environment node
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Holds every workspace package the guest site imports to the browser floor
 * this site checks its own source at (`lib` in `../tsconfig.json`, the floor in
 * the root `.browserslistrc`).
 *
 * `astro check` reports only this package's files, so an imported package's
 * source is checked by that package's own `check`, under its own tsconfig. Each
 * one must therefore state a `lib` no wider than this site's, load no ambient
 * types this site does not (`bun-types` declares newer built-ins whatever `lib`
 * says), run `tsc` on that tsconfig, and cover every module it exports. A new
 * workspace dependency fails here until it does, and until it joins `PACKAGES`.
 *
 * Deliberately static: reads package manifests and tsconfigs, builds nothing.
 */

const appRoot = resolve(import.meta.dirname, "..");

/**
 * Workspace packages this site lists in `devDependencies` that never reach a
 * browser. Every other workspace dependency, dev or not, is walked.
 */
const BUILD_ONLY: ReadonlyMap<string, string> = new Map([
  ["@cire/build-tools", "an Astro integration `astro.config.mjs` runs at build time"],
  ["@shared/dev-urls", "read by `astro.config.mjs` for the dev server's port"],
  ["@shared/typescript-config", "tsconfig presets, no code"],
]);

/** What the walk must find; a change to the graph is a change to this list. */
const PACKAGES = [
  "@cire/dietary",
  "@cire/invite-designs",
  "@cire/theme",
  "@cire/ui",
  "@shared/color",
  "@shared/design-tokens",
  "@shared/legal",
  "@shared/rp-auth",
  "@shared/toast",
  "@shared/ui",
];

type Exports = string | { readonly [entry: string]: Exports };

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly exports?: Exports;
  readonly scripts?: Readonly<Record<string, string>>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

function workspaceNames(deps: Manifest["dependencies"]): string[] {
  return Object.entries(deps ?? {})
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => name);
}

/**
 * Every workspace package reachable from this site: its own `dependencies` and
 * `devDependencies` less `BUILD_ONLY`, then each package's `dependencies`,
 * transitively (a package's own `devDependencies` are its test tooling). Each
 * resolves through its importer's `node_modules` link, as the bundler does.
 */
function walkPackages(): Map<string, string> {
  const own = readManifest(appRoot);
  const queue: Array<readonly [from: string, name: string]> = [
    ...workspaceNames(own.dependencies),
    ...workspaceNames(own.devDependencies),
  ]
    .filter((name) => !BUILD_ONLY.has(name))
    .map((name) => [appRoot, name] as const);
  const found = new Map<string, string>();
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [from, name] = next;
    if (found.has(name)) continue;
    const dir = realpathSync(join(from, "node_modules", name));
    found.set(name, dir);
    for (const dep of workspaceNames(readManifest(dir).dependencies)) queue.push([dir, dep]);
  }
  return found;
}

/** A package's `tsconfig.json` as written, and parsed with `extends` followed from its own directory. */
function readTsconfig(dir: string) {
  const file = join(dir, "tsconfig.json");
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dir, undefined, file);
  return { written: config as { compilerOptions?: { lib?: unknown } }, parsed };
}

function exportTargets(exports: Exports | undefined): string[] {
  if (exports === undefined) return [];
  if (typeof exports === "string") return [exports];
  return Object.values(exports).flatMap(exportTargets);
}

const site = readTsconfig(appRoot).parsed.options;
const packages = walkPackages();

describe("browser floor of the packages the guest site imports", () => {
  it("walks to every workspace package the site ships", () => {
    expect([...packages.keys()].toSorted()).toEqual(PACKAGES);
  });

  describe.each([...packages])("%s", (_name, dir) => {
    const manifest = readManifest(dir);
    const { written, parsed } = readTsconfig(dir);

    it("parses its tsconfig, extends included, without errors", () => {
      expect(
        parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
      ).toEqual([]);
    });

    it("states its own lib, no wider than the site's", () => {
      expect(written.compilerOptions?.lib).toBeDefined();
      expect(parsed.options.lib?.filter((lib) => !site.lib?.includes(lib))).toEqual([]);
    });

    it("lists no ambient types the site does not", () => {
      expect((parsed.options.types ?? []).filter((t) => !(site.types ?? []).includes(t))).toEqual(
        [],
      );
    });

    it("runs tsc on that tsconfig in its check script", () => {
      const first = (manifest.scripts?.check ?? "").split("&&")[0]?.trim();
      expect(first).toBe("tsc --noEmit");
    });

    it("checks every module it exports", () => {
      const modules = exportTargets(manifest.exports)
        .filter((target) => /\.tsx?$/.test(target))
        .map((target) => resolve(dir, target));
      expect(modules.length).toBeGreaterThan(0);
      expect(modules.filter((file) => !parsed.fileNames.includes(file))).toEqual([]);
    });
  });
});
