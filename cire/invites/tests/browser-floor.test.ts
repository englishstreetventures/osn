// @vitest-environment node
import { readdirSync, readFileSync, realpathSync } from "node:fs";
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
 * one must therefore state its own `lib`, build a program whose libraries stay
 * within this site's `lib` and that loads no Bun globals (`bun-types` declares
 * newer built-ins whatever `lib` says), run `tsc` on that tsconfig, and cover
 * every module it exports. A new workspace dependency fails here until it does,
 * and until it joins `PACKAGES`.
 *
 * Static: reads manifests and source, and builds TypeScript programs without
 * emitting anything.
 */

const appRoot = resolve(import.meta.dirname, "..");

/**
 * The floor, written out a second time on purpose: `.browserslistrc` names
 * Firefox 114 and Safari 16.4, which lack ES2023's `toSorted`. Raising it means
 * editing `../tsconfig.json` and this line together.
 */
const FLOOR_LIB = ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"];

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
 * transitively (a package's own `devDependencies` are its test tooling, which
 * the import scan below holds to). Each resolves through its importer's
 * `node_modules` link, as the bundler does.
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

/**
 * What a `tsc` run with these root files and options loads beyond the source:
 * the default libraries (from `lib`, a `/// <reference lib>`, or a type package
 * such as `@types/node` that references one), and whether any `bun-types` file
 * came in, by `types` or by a reference.
 */
function programGlobals(
  rootNames: readonly string[],
  options: ts.CompilerOptions,
  host?: ts.CompilerHost,
) {
  const program = ts.createProgram({ rootNames, options, host });
  const files = program.getSourceFiles();
  return {
    libs: files
      .filter((file) => program.isSourceFileDefaultLibrary(file))
      .map((file) => file.fileName.slice(file.fileName.lastIndexOf("/") + 1)),
    bun: files.some((file) => file.fileName.includes("/bun-types/")),
  };
}

/** The workspace packages a file imports, by bare `@cire/` or `@shared/` specifier. */
function workspaceImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const pattern = /\b(?:from|import)\s*\(?\s*["'](@(?:cire|shared)\/[a-z0-9-]+)/g;
  return [...text.matchAll(pattern)].map((match) => match[1]!);
}

function exportTargets(exports: Exports | undefined): string[] {
  if (exports === undefined) return [];
  if (typeof exports === "string") return [exports];
  return Object.values(exports).flatMap(exportTargets);
}

/**
 * The libraries the site's `lib` alone loads, with every level it builds on: a
 * program of one empty in-memory file, so nothing but `lib` adds to it.
 */
function floorLibraries(lib: readonly string[] | undefined): string[] {
  const options: ts.CompilerOptions = { lib: lib ? [...lib] : undefined, types: [], noEmit: true };
  const host = ts.createCompilerHost(options);
  const empty = join(appRoot, "floor.virtual.ts");
  const { fileExists, getSourceFile } = host;
  host.fileExists = (name) => name === empty || fileExists(name);
  host.getSourceFile = (name, version, ...rest) =>
    name === empty
      ? ts.createSourceFile(name, "export {};", version)
      : getSourceFile(name, version, ...rest);
  return programGlobals([empty], options, host).libs;
}

const site = readTsconfig(appRoot).parsed.options;
const floorLibs = floorLibraries(site.lib);
const packages = walkPackages();

describe("browser floor of the packages the guest site imports", () => {
  it("checks the site itself at the floor", () => {
    expect(site.lib).toEqual(FLOOR_LIB);
    expect(floorLibs).toContain("lib.es2022.array.d.ts");
  });

  it("walks to every workspace package the site ships", () => {
    expect([...packages.keys()].toSorted()).toEqual(PACKAGES);
  });

  it("lists its build-only packages as devDependencies only", () => {
    const own = readManifest(appRoot);
    const names = [...BUILD_ONLY.keys()];
    expect(names.filter((name) => own.devDependencies?.[name] === undefined)).toEqual([]);
    expect(names.filter((name) => own.dependencies?.[name] !== undefined)).toEqual([]);
  });

  it("imports no workspace package from its source that the walk misses", () => {
    const sources = readdirSync(join(appRoot, "src"), { recursive: true, encoding: "utf8" })
      .filter((path) => /\.(astro|tsx?|mjs)$/.test(path))
      .map((path) => join(appRoot, "src", path));
    const imported = new Set(sources.flatMap(workspaceImports));
    expect(
      [...imported].filter((name) => !PACKAGES.includes(name) && !BUILD_ONLY.has(name)),
    ).toEqual([]);
  });

  describe.each([...packages])("%s", (_name, dir) => {
    const manifest = readManifest(dir);
    const { written, parsed } = readTsconfig(dir);

    it("parses its tsconfig, extends included, without errors", () => {
      expect(
        parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
      ).toEqual([]);
    });

    it("states its own lib", () => {
      expect(written.compilerOptions?.lib).toBeDefined();
    });

    it("builds a program within the site's lib, with no Bun globals", () => {
      const globals = programGlobals(parsed.fileNames, parsed.options);
      expect(globals.libs.filter((lib) => !floorLibs.includes(lib))).toEqual([]);
      expect(globals.bun).toBe(false);
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

    it("imports from its source only workspace packages the walk reaches", () => {
      const sources = parsed.fileNames.filter((file) => file.startsWith(join(dir, "src") + "/"));
      const imported = new Set(sources.flatMap(workspaceImports));
      expect([...imported].filter((name) => !PACKAGES.includes(name))).toEqual([]);
    });
  });
});
