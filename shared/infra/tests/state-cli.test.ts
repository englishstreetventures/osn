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
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  "both contribute a state store",
];

/** What Effect throws when a module declares a record of optional values, which Effect 4.0.7 refuses. */
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
