import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { READS_REPO } from "../vitest.config";
import { ASSET_SITES, SOURCES } from "./support/asset-sites";

/** The Alchemy release whose source this package's builders were checked against. */
const AUDITED_ALCHEMY = "2.0.0-beta.84";

/** Alchemy's core and its Cloudflare provider, released together and pinned at that release. */
const ALCHEMY_PACKAGES = ["alchemy", "@alchemy.run/cloudflare"];

/** The packages every stack runs Alchemy with; each stack pins them at this package's versions. */
const PINNED = [
  "alchemy",
  "@alchemy.run/cloudflare",
  "effect",
  "@effect/platform-bun",
  "@effect/platform-node",
];

type Manifest = {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
};

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest;

/** The installed package `name` as `fromDir` resolves it: its directory and manifest. */
function installed(
  name: string,
  fromDir: string,
): { readonly dir: string; readonly manifest: Manifest } {
  let dir = dirname(createRequire(join(fromDir, "index.js")).resolve(name));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const manifest = readManifest(candidate);
      if (manifest.name === name) return { dir, manifest };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json for ${name} above ${fromDir}`);
    dir = parent;
  }
}

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const own = readManifest(join(packageDir, "package.json"));

describe("pinned Alchemy", () => {
  test("declares and installs the audited release of Alchemy and its Cloudflare provider", () => {
    for (const name of ALCHEMY_PACKAGES) {
      expect({ [name]: own.dependencies?.[name] }).toEqual({ [name]: AUDITED_ALCHEMY });
      expect({ [name]: installed(name, packageDir).manifest.version }).toEqual({
        [name]: AUDITED_ALCHEMY,
      });
    }
  });

  test("the Alchemy CLI and the Cloudflare provider it loads share one installed Alchemy", () => {
    // The CLI finds the Cloudflare state backend by importing the provider,
    // which imports Alchemy from its own directory: a second copy there would
    // hold services the CLI's copy does not know.
    const cli = realpathSync(installed("alchemy", packageDir).dir);
    const provider = installed("@alchemy.run/cloudflare", packageDir).dir;
    expect(realpathSync(installed("alchemy", provider).dir)).toBe(cli);
    expect(realpathSync(join(packageDir, "node_modules", ".bin", "alchemy"))).toBe(
      join(cli, "bin", "cli.js"),
    );
  });

  test("the lockfile resolves exactly one Effect, one Alchemy and one Cloudflare provider, the ones this package pins", () => {
    // `bun.lock` names each resolved copy as `"<name>@<version>"`; a second
    // copy appears as another version under a nested key such as
    // `"@effect/sql-d1/effect"`.
    const lock = readFileSync(join(packageDir, "..", "..", "bun.lock"), "utf8");
    for (const name of ["effect", ...ALCHEMY_PACKAGES]) {
      const literal = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      const versions = new Set(
        [...lock.matchAll(new RegExp(`"${literal}@([^"]+)"`, "g"))].map((match) => match[1]),
      );
      expect({ [name]: [...versions] }).toEqual({ [name]: [own.dependencies?.[name]] });
    }
  });

  test("every stack package pins Alchemy, its Cloudflare provider, Effect and both platform packages at this package's versions", () => {
    const repoRoot = join(packageDir, "..", "..");
    const stacks = readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, entry.name, "infra", "package.json"))
      .filter((path) => path !== join(packageDir, "package.json") && existsSync(path));
    expect(stacks.length).toBeGreaterThan(0);
    for (const path of stacks) {
      const stack = readManifest(path);
      for (const name of PINNED) {
        expect({ [`${stack.name} ${name}`]: stack.dependencies?.[name] }).toEqual({
          [`${stack.name} ${name}`]: own.dependencies?.[name],
        });
      }
    }
  });
});

describe("the vitest projects", () => {
  test("the repo project holds exactly the test files whose paths climb above this package", () => {
    // A file in the package project is cached on this package's files alone,
    // so one that read a workflow or another package from there would pass
    // from the cache after that file changed.
    const files = readdirSync(join(packageDir, "tests"), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".test.ts"))
      .map((path) => `tests/${path}`);
    const climbs = (file: string): boolean => {
      const source = readFileSync(join(packageDir, file), "utf8");
      const depth = file.split("/").length - 1;
      const ups = [...source.matchAll(/new URL\(\s*["'`]((?:\.\.\/)+)/g)].map(
        (match) => (match[1] ?? "").length / 3,
      );
      return ups.some((up) => up > depth) || /join\(packageDir,\s*"\.\.",\s*"\.\."/.test(source);
    };
    // A test file reads what the support modules it imports read.
    const supportOf = (file: string): string[] =>
      [
        ...readFileSync(join(packageDir, file), "utf8").matchAll(/from "\.\/support\/([\w-]+)"/g),
      ].map((match) => `tests/support/${match[1]}.ts`);
    // A file that runs one of this package's Alchemy scripts runs the whole
    // installed Alchemy tree: the CLI finds its providers in every installed
    // package's manifest, and the lockfile and the root manifest's overrides
    // decide which packages those are.
    const alchemyScripts = Object.entries(own.scripts ?? {})
      .filter(([, command]) => /\balchemy\s/.test(command))
      .map(([name]) => name);
    const runsAlchemy = (file: string): boolean => {
      const source = readFileSync(join(packageDir, file), "utf8");
      return alchemyScripts.some((name) => source.includes(`"${name}"`));
    };
    const climbing = files.filter(
      (file) => climbs(file) || supportOf(file).some(climbs) || runsAlchemy(file),
    );
    expect(climbing.toSorted()).toEqual(READS_REPO.toSorted());
  });
});

describe("the repo project's cache", () => {
  // turbo reruns `test:repo` only when one of its inputs changes, and CI
  // restores its cache, so a file AC6 or AC7 reads that is not an input lets
  // them pass from the cache after it changed.
  test("PK1: every asset site's public directory, and every stack declaration, is a test:repo input", () => {
    const turbo = Bun.JSONC.parse(readFileSync(join(packageDir, "turbo.json"), "utf8")) as {
      readonly tasks: Readonly<Record<string, { readonly inputs?: readonly string[] }>>;
    };
    const inputs = turbo.tasks["test:repo"]?.inputs ?? [];
    expect(ASSET_SITES.length).toBeGreaterThan(0);
    for (const { publicDir } of ASSET_SITES)
      expect(inputs).toContain(`$TURBO_ROOT$/${publicDir}/**`);
    expect(SOURCES.length).toBeGreaterThan(0);
    for (const source of SOURCES) expect(inputs).toContain(`$TURBO_ROOT$/${source}`);
  });
});
