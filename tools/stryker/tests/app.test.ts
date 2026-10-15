// The command is run through Stricli with a stand-in context, so each test
// sees exactly the Stryker invocation (or the refusal) a person would get.

import { expect, test } from "bun:test";

import { run } from "@stricli/core";

import { app, type MutationContext } from "../src/app.ts";

const ROOT = "/repo";

function harness(
  options: { cwd?: string; config?: boolean; git?: Record<string, string | undefined> } = {},
) {
  const out = { stdout: "", stderr: "" };
  const spawned: { cmd: readonly string[]; cwd: string }[] = [];
  const context: MutationContext = {
    process: {
      stdout: { write: (s: string) => void (out.stdout += s) },
      stderr: { write: (s: string) => void (out.stderr += s) },
      exitCode: undefined,
    },
    cwd: options.cwd ?? "/repo/cire/host",
    repoRoot: ROOT,
    exists: (path) => (options.config ?? true) && path.endsWith("/stryker/config.mjs"),
    git: (args) => options.git?.[args[0] ?? ""],
    spawn: async (cmd, cwd) => {
      spawned.push({ cmd, cwd });
      return 3;
    },
  };
  return { context, out, spawned, go: (argv: string[]) => run(app, argv, context) };
}

const STRYKER = ["/repo/node_modules/.bin/stryker", "run", "cire/host/stryker/config.mjs"];

test("runs the package's config from the repo root and passes Stryker's exit code on", async () => {
  const h = harness();
  await h.go([]);
  expect(h.spawned).toEqual([{ cmd: STRYKER, cwd: ROOT }]);
  expect(h.context.process.exitCode).toBe(3);
});

test("roots every --mutate entry and joins them for Stryker", async () => {
  const h = harness();
  await h.go(["--mutate", "src/a.ts,/repo/cire/host/src/b.ts:1-4", "--mutate", " src/c.ts "]);
  expect(h.spawned[0]?.cmd).toEqual([
    ...STRYKER,
    "--mutate",
    "cire/host/src/a.ts,cire/host/src/b.ts:1-4,cire/host/src/c.ts",
  ]);
});

test("refuses an empty --mutate entry instead of mutating nothing", async () => {
  const h = harness();
  await h.go(["--mutate", "src/a.ts,,"]);
  expect(h.spawned).toEqual([]);
  expect(h.context.process.exitCode).not.toBe(0);
});

test("maps its own flags to Stryker's and passes anything after -- through", async () => {
  const h = harness();
  await h.go(["--incremental", "--dry-run", "--concurrency", "2", "--", "--logLevel", "debug"]);
  expect(h.spawned[0]?.cmd).toEqual([
    ...STRYKER,
    "--incremental",
    "--dryRunOnly",
    "--concurrency",
    "2",
    "--logLevel",
    "debug",
  ]);
});

test("--changed mutates the changed lines since the merge base", async () => {
  const h = harness({
    git: {
      "merge-base": "abc123\n",
      diff: "+++ b/cire/host/src/lib/a.ts\n@@ -3 +3,2 @@\n",
      "ls-files": "cire/host/src/lib/new.ts\n",
    },
  });
  await h.go(["--changed"]);
  expect(h.spawned[0]?.cmd).toEqual([
    ...STRYKER,
    "--mutate",
    "cire/host/src/lib/a.ts:3-4,cire/host/src/lib/new.ts",
  ]);
});

test("--changed with nothing changed says so and runs nothing", async () => {
  const h = harness({ git: { "merge-base": "abc123\n", diff: "", "ls-files": "" } });
  await h.go(["--base", "feat/parent"]);
  expect(h.spawned).toEqual([]);
  expect(h.out.stdout).toContain("no changed source lines under cire/host/src since feat/parent");
  expect(h.context.process.exitCode ?? 0).toBe(0);
});

test("--changed fails when there is no merge base", async () => {
  const h = harness({ git: {} });
  await h.go(["--changed"]);
  expect(h.spawned).toEqual([]);
  expect(h.context.process.exitCode).not.toBe(0);
});

test("--changed and --mutate together are refused", async () => {
  const h = harness();
  await h.go(["--changed", "--mutate", "src/a.ts"]);
  expect(h.spawned).toEqual([]);
  expect(h.context.process.exitCode).not.toBe(0);
});

test("refuses a directory outside cire/", async () => {
  const h = harness({ cwd: "/repo/osn/api" });
  await h.go([]);
  expect(h.spawned).toEqual([]);
  expect(h.out.stderr).toContain("run from a cire package");
});

test("refuses a cire package with no stryker/config.mjs", async () => {
  const h = harness({ config: false });
  await h.go([]);
  expect(h.spawned).toEqual([]);
  expect(h.out.stderr).toContain("run from a cire package");
});
