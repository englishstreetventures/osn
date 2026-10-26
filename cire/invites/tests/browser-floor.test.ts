// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { API } from "typescript/sync";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Holds the guest site, and every workspace package it imports, to the browser
 * floor (`lib` in `../tsconfig.json`, the floor in the root `.browserslistrc`).
 *
 * The site's `typecheck` is one `tsc` program that loads each imported
 * workspace package's source, `.astro` files included, and checks it at the
 * site's `lib`. That holds only while the program loads no library above the
 * floor: `bun-types` declares newer built-ins whatever `lib` says, and so does a
 * `/// <reference lib>` in any type package. A new workspace dependency also
 * fails here until it joins `PACKAGES`.
 *
 * Static: reads manifests and source, and lists the program's files with
 * `tsc --listFilesOnly` without checking or emitting anything.
 */

const appRoot = resolve(import.meta.dirname, "..");

/**
 * The floor, written out a second time on purpose: `.browserslistrc` names
 * Firefox 114 and Safari 16.4, which lack ES2023's `toSorted`. Raising it means
 * editing `../tsconfig.json` and this line together.
 */
const FLOOR_LIB = ["ES2022", "DOM", "DOM.Iterable"];

/** `ES2022` and `DOM` with every library they build on. */
const FLOOR_FILES =
  /^lib\.(es5|es20(1[5-9]|2[0-2])(\.[a-z.]+)?|dom(\.iterable)?|decorators(\.legacy)?)\.d\.ts$/;

/**
 * The site program also loads `@types/node`: Astro's and Vite's own types
 * reference it, and `types: []` cannot keep a `/// <reference types>` out. It
 * brings `es2025.float16` and `esnext.disposable`, so `Float16Array`,
 * `DisposableStack` and `Buffer` type-check in the site's own source though the
 * floor browsers lack them; that stays a review rule. Each package the site
 * imports is held to the floor by its own `bun check`, under a config that
 * loads no type package (the per-package cases below).
 */
const SITE_EXTRA_FILES = /^lib\.(es2025\.float16|esnext\.disposable)\.d\.ts$/;

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
  "@cire/guest-email",
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

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
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
function walkPackages(): Map<string, { dir: string; manifest: Manifest }> {
  const own = readManifest(appRoot);
  const queue: Array<readonly [from: string, name: string]> = [
    ...workspaceNames(own.dependencies),
    ...workspaceNames(own.devDependencies),
  ]
    .filter((name) => !BUILD_ONLY.has(name))
    .map((name) => [appRoot, name] as const);
  const found = new Map<string, { dir: string; manifest: Manifest }>();
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [from, name] = next;
    if (found.has(name)) continue;
    const dir = realpathSync(join(from, "node_modules", name));
    const manifest = readManifest(dir);
    found.set(name, { dir, manifest });
    for (const dep of workspaceNames(manifest.dependencies)) queue.push([dir, dep]);
  }
  return found;
}

/**
 * The files the site's own type check loads: `tsc -p . --listFilesOnly` with
 * the `.astro` content mapper, the same program `typecheck` checks. Workspace
 * packages the site imports are in it as source, checked at the site's `lib`.
 */
function programFiles(project: string, ...flags: string[]): string[] {
  const tsc = join(appRoot, "node_modules", ".bin", "tsc");
  const out = execFileSync(tsc, ["-p", project, ...flags, "--listFilesOnly"], {
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

/** The `lib` file names a program loads. */
function libFiles(files: readonly string[]): string[] {
  return files
    .map((file) => file.slice(file.lastIndexOf("/") + 1))
    .filter((name) => /^lib\..*\.d\.ts$/.test(name));
}

/** `compilerOptions` as a `tsconfig.json` writes it (JSONC, so TypeScript reads it). */
const api = new API({ cwd: appRoot });
afterAll(() => api.close());

function writtenOptions(dir: string): { lib?: unknown; types?: unknown } {
  const { config, error } = api.readConfigFile(join(dir, "tsconfig.json"));
  if (error) throw new Error(error.text);
  return (config as { compilerOptions?: { lib?: unknown; types?: unknown } }).compilerOptions ?? {};
}

/** The workspace packages a file imports, by bare `@cire/` or `@shared/` specifier. */
function workspaceImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const pattern = /\b(?:from|import)\s*\(?\s*["'](@(?:cire|shared)\/[a-z0-9-]+)/g;
  return [...text.matchAll(pattern)].map((match) => match[1]!);
}

const siteLib = writtenOptions(appRoot).lib;
const files = programFiles(appRoot, "--runExternalCode");
const libs = libFiles(files);
const packages = walkPackages();

describe("browser floor of the guest site and the packages it imports", () => {
  it("checks the site itself at the floor", () => {
    expect(siteLib).toEqual(FLOOR_LIB);
    expect(libs).toContain("lib.es2022.array.d.ts");
  });

  it("loads no library above the floor and no Bun globals", () => {
    expect(libs.filter((lib) => !FLOOR_FILES.test(lib) && !SITE_EXTRA_FILES.test(lib))).toEqual([]);
    expect(files.filter((file) => file.includes("/bun-types/"))).toEqual([]);
  });

  it("checks every .astro file in its source", () => {
    const astro = readdirSync(join(appRoot, "src"), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".astro"))
      .map((path) => join(appRoot, "src", path));
    expect(astro.length).toBeGreaterThan(0);
    expect(astro.filter((file) => !files.includes(file))).toEqual([]);
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

  describe.each([...packages])("%s", (_name, { dir, manifest }) => {
    const src = join(dir, "src") + "/";

    it("states the floor as its own lib", () => {
      const options = writtenOptions(dir);
      expect(options.lib).toBeDefined();
      expect(
        (options.lib as string[]).filter(
          (lib) => !FLOOR_LIB.some((floor) => floor.toLowerCase() === lib.toLowerCase()),
        ),
      ).toEqual([]);
    });

    it("builds a program within the floor, with no Bun or Node globals", () => {
      const own = programFiles(dir);
      expect(libFiles(own).filter((lib) => !FLOOR_FILES.test(lib))).toEqual([]);
      expect(own.filter((file) => /\/(bun-types|@types\/node)\//.test(file))).toEqual([]);
    });

    it("type-checks itself with bun check, with no check script to shadow it", () => {
      expect(manifest.scripts?.typecheck ?? "").toMatch(/\bbun check\b/);
      expect(manifest.scripts?.check).toBeUndefined();
    });

    // Source, never built declarations: a `.d.ts` from `dist/` would carry the
    // package's types into the program without its code, unchecked at the floor.
    it("reaches the site program only as source", () => {
      const own = files.filter((file) => file.startsWith(dir + "/"));
      expect(own.filter((file) => !file.startsWith(src))).toEqual([]);
    });

    it("imports from its source only workspace packages the walk reaches", () => {
      const sources = readdirSync(src, { recursive: true, encoding: "utf8" })
        .filter((path) => /\.(astro|tsx?|mjs)$/.test(path))
        .map((path) => join(src, path));
      const imported = new Set(sources.flatMap(workspaceImports));
      expect([...imported].filter((name) => !PACKAGES.includes(name))).toEqual([]);
    });
  });
});
