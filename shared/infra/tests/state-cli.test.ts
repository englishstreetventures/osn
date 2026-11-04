/**
 * `state:check` and `state:bootstrap`, which the state-store workflow and every
 * production release run, run here as those runs do but with no Cloudflare
 * credentials. Each must load the whole installed Alchemy tree, find the
 * Cloudflare state backend and stop at the missing token, so a module that
 * fails to load, or a backend the CLI cannot find, fails here rather than in a
 * release's plan job.
 *
 * Neither run can reach an account. Its environment is built here and holds no
 * token and no `CI`, so only the script's own `CI=true` keeps Alchemy on
 * environment credentials; `HOME` is an empty directory, so no stored profile
 * or cached state-store token is read; and Alchemy reads an empty env file in
 * place of `.env`. Bun loads a package's `.env` files into a script's
 * environment by itself, so these tests refuse to run while this package holds
 * one.
 *
 * It runs the installed Alchemy tree, which the lockfile, the root manifest
 * and the patches decide (`RUNS_ALCHEMY`). Both runs start together, before
 * any test, and each test reads its run's result.
 *
 * A run loads only the modules the CLI imports at start-up, through Bun's
 * `src/` copies. SC6 reads the rest of the tree: every Effect module any file
 * of an installed Alchemy package names, in either copy or a type
 * declaration, must exist in the installed Effect, so a module that would fail
 * only when a deploy first reaches it fails here too.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** How long one run may take; loading every Cloudflare module takes a few seconds. */
const RUN_TIMEOUT_MS = 60_000;

/** The scripts these tests run. */
type Script = "state:check" | "state:bootstrap";

/** The error Alchemy's Cloudflare provider stops with when CI holds no credentials. */
const NO_CREDENTIALS = "Cloudflare CI credentials not found";

/** What Alchemy prints when a provider package fails to load or its state backend is missing. */
const DISCOVERY_FAILURES = [
  "Unknown state backend",
  "Skipping @alchemy.run/cloudflare",
  "Could not load cloudflare",
  "Could not import a provider module",
  "both contribute a state store",
];

/** What Effect throws when a module declares a record of optional values, which Effect refuses. */
const OPTIONAL_RECORD = "Cannot use `Schema.optionalKey`";

interface Run {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** stdout and stderr together. */
  readonly output: string;
}

const runs = new Map<Script, Promise<Run>>();

/** Runs `bun run <script>` in this package with no credentials, once per script. */
function run(script: Script): Promise<Run> {
  const started = runs.get(script);
  if (started !== undefined) return started;
  const outcome = spawnScript(script);
  runs.set(script, outcome);
  return outcome;
}

async function spawnScript(script: Script): Promise<Run> {
  const envFiles = readdirSync(packageDir).filter((name) => name.startsWith(".env"));
  if (envFiles.length > 0) {
    throw new Error(
      `${envFiles.join(", ")} in ${packageDir}: Bun loads it into the script's environment, so this test will not run Alchemy while it is there`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "state-cli-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home);
    const emptyEnv = join(dir, "empty.env");
    writeFileSync(emptyEnv, "");
    const child = Bun.spawn(
      ["bun", "--no-env-file", "run", "--cwd", packageDir, script, "--", "--env-file", emptyEnv],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          DO_NOT_TRACK: "1",
          CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, RUN_TIMEOUT_MS);
    // Both pipes are read while the process runs, so a full pipe never
    // blocks it.
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return { exitCode: child.exitCode, timedOut, output: `${stdout}${stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Both CLIs start at once; each cold start loads the whole provider tree.
beforeAll(async () => {
  await Promise.all([run("state:check"), run("state:bootstrap")]);
}, 2 * RUN_TIMEOUT_MS);

describe("state:check with no credentials", () => {
  test("SC1: stops at the missing Cloudflare token and fails", async () => {
    const { exitCode, output } = await run("state:check");
    expect(output).toContain(NO_CREDENTIALS);
    expect(exitCode).not.toBe(0);
  });

  test("SC2: finds the Cloudflare state backend and loads its provider", async () => {
    const { output } = await run("state:check");
    for (const failure of DISCOVERY_FAILURES) expect(output).not.toContain(failure);
  });

  test("SC3: loads no module that Effect refuses", async () => {
    expect((await run("state:check")).output).not.toContain(OPTIONAL_RECORD);
  });

  test("SC4: finishes inside the timeout", async () => {
    expect((await run("state:check")).timedOut).toBe(false);
  });
});

describe("state:bootstrap with no credentials", () => {
  test("SC5: runs the current bootstrap command and stops at the missing Cloudflare token", async () => {
    const { exitCode, output, timedOut } = await run("state:bootstrap");
    expect(timedOut).toBe(false);
    expect(output).not.toContain("has been moved");
    expect(output).not.toContain(OPTIONAL_RECORD);
    for (const failure of DISCOVERY_FAILURES) expect(output).not.toContain(failure);
    expect(output).toContain(NO_CREDENTIALS);
    expect(exitCode).not.toBe(0);
  });
});

/** The packages SC6 reads: Alchemy's core, its scoped packages and the Cloudflare SDK they share. */
const TREE_PACKAGE = /^(alchemy|@alchemy\.run\/[^/]+|@distilled\.cloud\/[^/]+)$/;

/** The packages each stack depends on, from which SC6 walks the rest of the tree. */
const TREE_ROOTS = ["alchemy", "@alchemy.run/cloudflare"];

/** Source and declaration files whose imports a runtime or the type-checker follows. */
const MODULE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;

/**
 * Each Effect module a file names — `from "…"`, `import("…")`, `require("…")`
 * or a bare `import "…"` — as the package (group 1) and the whole specifier.
 */
const EFFECT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']((effect|@effect\/[\w.-]+)(?:\/[^"']*)?)["']/gm;

/**
 * The real directory of package `name` as a module in `fromDir` finds it: the
 * first `node_modules/<name>` from `fromDir` upwards. Bun's isolated install
 * links each package's dependencies and peers beside it in the store, so this
 * reaches the copy that package loads, never a stale store entry.
 */
function packageDirFrom(name: string, fromDir: string): string | undefined {
  for (let current = fromDir; ; current = dirname(current)) {
    const manifest = join(current, "node_modules", name, "package.json");
    if (existsSync(manifest)) return realpathSync(dirname(manifest));
    if (dirname(current) === current) return undefined;
  }
}

type TreeManifest = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
};

/** Every installed Alchemy-tree package the stacks reach, by real directory. */
function treePackages(): string[] {
  const found = new Set<string>();
  const pending = TREE_ROOTS.map((name) => {
    const dir = packageDirFrom(name, packageDir);
    if (dir === undefined) throw new Error(`${name} is not installed in ${packageDir}`);
    return dir;
  });
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (found.has(dir)) continue;
    found.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as TreeManifest;
    const names = Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    }).filter((name) => TREE_PACKAGE.test(name));
    // An optional peer that is not installed, such as the frontend
    // frameworks package, is not part of the tree.
    for (const name of names) {
      const next = packageDirFrom(name, dir);
      if (next !== undefined) pending.push(next);
    }
  }
  return [...found].toSorted();
}

/** Every module file under `dir`, outside any nested `node_modules`. */
function moduleFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => MODULE_FILE.test(path) && !path.split("/").includes("node_modules"))
    .map((path) => join(dir, path));
}

describe("the installed Alchemy tree", () => {
  test("SC6: every Effect module its packages name, in any copy or declaration, exists in the installed Effect", () => {
    // Named exports are not checked: the runs above load the start-up path,
    // and a missing export there fails SC1 and SC5. An `@effect/*` package
    // that is not installed is an optional peer (a SQL driver no stack uses),
    // which Alchemy imports only for a resource that needs it.
    const packages = treePackages();
    // The walk reaches the Cloudflare SDK the provider deploys through, so a
    // narrowed walk fails here rather than checking almost nothing.
    const provider = packageDirFrom("@alchemy.run/cloudflare", packageDir) ?? "";
    expect(packages).toEqual(
      expect.arrayContaining(
        ["@distilled.cloud/cloudflare", "@distilled.cloud/core"].map((name) =>
          packageDirFrom(name, provider),
        ),
      ),
    );
    const missing: string[] = [];
    let checked = 0;
    for (const dir of packages) {
      const installed = new Map<string, boolean>();
      const resolves = new Map<string, boolean>();
      const isInstalled = (name: string): boolean => {
        let known = installed.get(name);
        if (known === undefined) {
          known = name === "effect" || packageDirFrom(name, dir) !== undefined;
          installed.set(name, known);
        }
        return known;
      };
      const resolvesFrom = (specifier: string): boolean => {
        let known = resolves.get(specifier);
        if (known === undefined) {
          try {
            Bun.resolveSync(specifier, dir);
            known = true;
          } catch {
            known = false;
          }
          resolves.set(specifier, known);
        }
        return known;
      };
      for (const file of moduleFiles(dir)) {
        for (const match of readFileSync(file, "utf8").matchAll(EFFECT_SPECIFIER)) {
          const specifier = match[1] ?? "";
          if (!isInstalled(match[2] ?? "")) continue;
          checked += 1;
          if (!resolvesFrom(specifier))
            missing.push(`${relative(dirname(dir), file)}: ${specifier}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
