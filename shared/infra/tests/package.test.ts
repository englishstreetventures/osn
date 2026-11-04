import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import config, { READS_REPO, RUNS_ALCHEMY } from "../vitest.config";
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
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly alchemy?: { readonly contributes?: readonly string[] };
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
const repoRoot = join(packageDir, "..", "..");
const own = readManifest(join(packageDir, "package.json"));

/** Every stack package (`<product>/infra`), each of which runs its own `bun alchemy`. */
const stackDirs = readdirSync(repoRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(repoRoot, entry.name, "infra"))
  .filter((dir) => dir !== join(packageDir) && existsSync(join(dir, "package.json")));

/** This package, whose state scripts run Alchemy, and every stack package. */
const alchemyDirs = [join(packageDir), ...stackDirs];

const named = (dir: string): string => relative(repoRoot, dir);

/** `node_modules/<name>/package.json` from `dir` upwards, as Alchemy finds a dependency's manifest. */
function dependencyManifest(dir: string, name: string): Manifest | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, "node_modules", name, "package.json");
    if (existsSync(candidate)) return readManifest(candidate);
    if (dirname(current) === current) return undefined;
  }
}

/**
 * The installed packages whose modules Alchemy's CLI imports as providers when
 * it starts in `dir`, found as `candidatePackages`, `findDependencyManifest`
 * and `discover` in `alchemy/src/Contributions.ts` find them: the dependency
 * and devDependency names of every package.json from `dir` up to the
 * filesystem root, and every entry of a `node_modules/@alchemy.run` on that
 * path, each resolved from `dir` upwards; those whose manifest declares
 * `alchemy.contributes`.
 */
function providerPackages(dir: string): string[] {
  const names = new Set<string>();
  for (let current = dir; ; current = dirname(current)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readManifest(manifestPath);
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
        names.add(name);
      }
    }
    const scope = join(current, "node_modules", "@alchemy.run");
    if (existsSync(scope))
      for (const entry of readdirSync(scope)) names.add(`@alchemy.run/${entry}`);
    if (dirname(current) === current) break;
  }
  return [...names]
    .filter((name) => (dependencyManifest(dir, name)?.alchemy?.contributes ?? []).length > 0)
    .toSorted();
}

describe("pinned Alchemy", () => {
  test("declares and installs the audited release of Alchemy and its Cloudflare provider", () => {
    for (const name of ALCHEMY_PACKAGES) {
      expect({ [name]: own.dependencies?.[name] }).toEqual({ [name]: AUDITED_ALCHEMY });
      expect({ [name]: installed(name, packageDir).manifest.version }).toEqual({
        [name]: AUDITED_ALCHEMY,
      });
    }
  });

  test("in this package and every stack, the Alchemy CLI and the Cloudflare provider it loads share one installed Alchemy", () => {
    // The CLI finds the Cloudflare state backend by importing the provider,
    // which imports Alchemy from its own directory in the store: a second copy
    // there would hold services the CLI's copy does not know. Bun and Node
    // resolve a module's imports from its real path, so the lookup starts from
    // the provider's real directory. From the workspace's link to it, the
    // lookup would reach the workspace's own `alchemy` and could never differ.
    for (const dir of alchemyDirs) {
      const cli = realpathSync(installed("alchemy", dir).dir);
      const provider = realpathSync(installed("@alchemy.run/cloudflare", dir).dir);
      expect({ [named(dir)]: realpathSync(installed("alchemy", provider).dir) }).toEqual({
        [named(dir)]: cli,
      });
      expect({
        [named(dir)]: realpathSync(join(dir, "node_modules", ".bin", "alchemy")),
      }).toEqual({ [named(dir)]: join(cli, "bin", "cli.js") });
    }
  });

  test("the lockfile resolves exactly one Effect, one Alchemy and one Cloudflare provider, the ones this package pins", () => {
    // `bun.lock` names each resolved copy as `"<name>@<version>"`; a second
    // copy appears as another version under a nested key such as
    // `"@effect/sql-d1/effect"`.
    const lock = readFileSync(join(repoRoot, "bun.lock"), "utf8");
    for (const name of ["effect", ...ALCHEMY_PACKAGES]) {
      const literal = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      const versions = new Set(
        [...lock.matchAll(new RegExp(`"${literal}@([^"]+)"`, "g"))].map((match) => match[1]),
      );
      expect({ [name]: [...versions] }).toEqual({ [name]: [own.dependencies?.[name]] });
    }
  });

  test("the lockfile resolves no @distilled.cloud/aws and neither of the provider's optional Alchemy peers", () => {
    // `@distilled.cloud/aws` builds a record of optional values, a schema
    // Effect refuses, and the provider reaches it lazily, from an R2
    // bucket, so a deploy would fail long after start-up checks passed.
    // `@alchemy.run/frontend-frameworks` depends on it. `@alchemy.run/domain`
    // is used by no stack, and the dependency review in
    // wiki/shared/infrastructure-as-code.md covers only what is installed.
    // A resolved copy appears as `"<name>@<version>"`; a peer or optional
    // peer named in another entry's metadata appears without the `@`.
    const lock = readFileSync(join(repoRoot, "bun.lock"), "utf8");
    const barred = [
      "@distilled.cloud/aws",
      "@alchemy.run/frontend-frameworks",
      "@alchemy.run/domain",
    ];
    expect(barred.filter((name) => lock.includes(`"${name}@`))).toEqual([]);
  });

  test("Alchemy's CLI, started in this package or any stack, imports exactly one provider package, @alchemy.run/cloudflare", () => {
    // The CLI imports every installed package that declares
    // `alchemy.contributes`, into the process that holds the deploy token,
    // whether or not a stack imports it: any dependency of an infra package or
    // of the repository root becomes a provider by adding that field.
    expect(stackDirs.length).toBeGreaterThan(0);
    for (const dir of alchemyDirs) {
      expect({ [named(dir)]: providerPackages(dir) }).toEqual({
        [named(dir)]: ["@alchemy.run/cloudflare"],
      });
    }
  });

  test("every stack package pins Alchemy, its Cloudflare provider, Effect and both platform packages at this package's versions", () => {
    expect(stackDirs.length).toBeGreaterThan(0);
    for (const dir of stackDirs) {
      const stack = readManifest(join(dir, "package.json"));
      for (const name of PINNED) {
        expect({ [`${stack.name} ${name}`]: stack.dependencies?.[name] }).toEqual({
          [`${stack.name} ${name}`]: own.dependencies?.[name],
        });
      }
    }
  });
});

type Project = {
  readonly test: {
    readonly name: string;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
};

type Turbo = {
  readonly tasks: Readonly<
    Record<string, { readonly inputs?: readonly string[]; readonly dependsOn?: readonly string[] }>
  >;
};

const packageTurbo = (): Turbo =>
  Bun.JSONC.parse(readFileSync(join(packageDir, "turbo.json"), "utf8")) as Turbo;

describe("the vitest projects", () => {
  test("the repo project holds exactly the test files whose paths climb above this package, and the alchemy project exactly those that run one of its Alchemy scripts", () => {
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
    // package's manifest, and the lockfile, the root manifest and the patches
    // decide which packages those are.
    const alchemyScripts = Object.entries(own.scripts ?? {})
      .filter(([, command]) => /\balchemy\s/.test(command))
      .map(([name]) => name);
    const runsAlchemy = (file: string): boolean => {
      const source = readFileSync(join(packageDir, file), "utf8");
      return alchemyScripts.some((name) => source.includes(`"${name}"`));
    };
    const reading = files.filter((file) => climbs(file) || supportOf(file).some(climbs));
    const running = files.filter(runsAlchemy);
    // The alchemy project's inputs name only what the installed tree depends
    // on, so a file there reads nothing else outside the package.
    expect(running.filter((file) => reading.includes(file))).toEqual([]);
    expect(reading.toSorted()).toEqual(READS_REPO.toSorted());
    expect(running.toSorted()).toEqual(RUNS_ALCHEMY.toSorted());
  });

  test("each test file runs in exactly one project: package, repo or alchemy", () => {
    const projects = (config.test?.projects ?? []) as unknown as readonly Project[];
    const byName = Object.fromEntries(projects.map((project) => [project.test.name, project.test]));
    expect(Object.keys(byName).toSorted()).toEqual(["alchemy", "package", "repo"]);
    expect(byName.package?.include).toEqual(["tests/**/*.test.ts"]);
    expect([...(byName.package?.exclude ?? [])].toSorted()).toEqual(
      [...READS_REPO, ...RUNS_ALCHEMY].toSorted(),
    );
    expect([...(byName.repo?.include ?? [])].toSorted()).toEqual(READS_REPO.toSorted());
    expect([...(byName.alchemy?.include ?? [])].toSorted()).toEqual(RUNS_ALCHEMY.toSorted());
  });
});

describe("the repo project's cache", () => {
  // turbo reruns `test:repo` only when one of its inputs changes, and CI
  // restores its cache, so a file AC6 or AC7 reads that is not an input lets
  // them pass from the cache after it changed.
  test("PK1: every asset site's public directory, and every stack declaration, is a test:repo input", () => {
    const inputs = packageTurbo().tasks["test:repo"]?.inputs ?? [];
    expect(ASSET_SITES.length).toBeGreaterThan(0);
    for (const { publicDir } of ASSET_SITES)
      expect(inputs).toContain(`$TURBO_ROOT$/${publicDir}/**`);
    expect(SOURCES.length).toBeGreaterThan(0);
    for (const source of SOURCES) expect(inputs).toContain(`$TURBO_ROOT$/${source}`);
  });
});

describe("the alchemy project's cache", () => {
  // CI reaches these tests only through `turbo test`, which runs
  // `test:alchemy` because `test` depends on it, and replays it from the cache
  // unless one of its inputs changed.
  test("turbo's test task runs test:alchemy, which reruns whenever the installed Alchemy tree or this package can change", () => {
    const { tasks } = packageTurbo();
    expect(tasks.test?.dependsOn).toEqual(expect.arrayContaining(["test:repo", "test:alchemy"]));
    expect(own.scripts?.["test:alchemy"]).toBe("bunx --bun vitest run --project alchemy");
    const inputs = tasks["test:alchemy"]?.inputs ?? [];
    for (const input of [
      "$TURBO_DEFAULT$",
      "$TURBO_ROOT$/bun.lock",
      "$TURBO_ROOT$/package.json",
      "$TURBO_ROOT$/bunfig.toml",
      "$TURBO_ROOT$/patches/**",
      "$TURBO_ROOT$/.bun-version",
    ]) {
      expect(inputs).toContain(input);
    }
  });
});
