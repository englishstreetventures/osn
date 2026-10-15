// `scripts/stryker-cire.ts` runs Stryker from the repo root, so the package-
// relative `--mutate` paths a person types from `cire/<pkg>` must be rewritten
// to root-relative ones. A path Stryker cannot match mutates nothing and exits
// 0, which reads as a clean run, so every malformed shape is pinned here.

import { expect, test } from "bun:test";

import { refusal, rewriteArgs, rewriteMutate, strykerCommand } from "../stryker-cire";

const ROOT = "/repo";

test("rewriteMutate roots each comma-separated entry at the package", () => {
  expect(rewriteMutate("src/a.ts,src/b.tsx", "cire/host", ROOT)).toBe(
    "cire/host/src/a.ts,cire/host/src/b.tsx",
  );
});

test("rewriteMutate keeps a line range and an exclusion", () => {
  expect(rewriteMutate("src/a.ts:20-48,!src/b.ts", "cire/vendor", ROOT)).toBe(
    "cire/vendor/src/a.ts:20-48,!cire/vendor/src/b.ts",
  );
});

test("rewriteMutate leaves an entry that is already root-relative", () => {
  expect(rewriteMutate("cire/api/src/lib/money.ts", "cire/api", ROOT)).toBe(
    "cire/api/src/lib/money.ts",
  );
});

test("rewriteMutate makes an absolute path root-relative", () => {
  expect(
    rewriteMutate("/repo/cire/host/src/a.ts:3-9,!/repo/cire/host/src/b.ts", "cire/host", ROOT),
  ).toBe("cire/host/src/a.ts:3-9,!cire/host/src/b.ts");
});

test("rewriteMutate trims spaces and drops empty entries", () => {
  expect(rewriteMutate(" src/a.ts , src/b.ts,,", "cire/ui", ROOT)).toBe(
    "cire/ui/src/a.ts,cire/ui/src/b.ts",
  );
});

test("rewriteArgs rewrites --mutate, -m and --mutate= and passes the rest through", () => {
  expect(
    rewriteArgs(
      ["--mutate", "src/a.ts", "--concurrency", "2", "-m", "src/b.ts", "--mutate=src/c.ts"],
      "cire/ui",
      ROOT,
    ),
  ).toEqual([
    "--mutate",
    "cire/ui/src/a.ts",
    "--concurrency",
    "2",
    "-m",
    "cire/ui/src/b.ts",
    "--mutate=cire/ui/src/c.ts",
  ]);
});

test("rewriteArgs leaves a trailing --mutate with no value alone", () => {
  expect(rewriteArgs(["--mutate"], "cire/ui", ROOT)).toEqual(["--mutate"]);
});

test("strykerCommand runs the package's config from the repo root with rewritten arguments", () => {
  expect(strykerCommand("/repo/cire/host", ["--mutate", "src/a.ts", "--dryRunOnly"], ROOT)).toEqual(
    {
      cmd: [
        "/repo/node_modules/.bin/stryker",
        "run",
        "cire/host/stryker.config.mjs",
        "--mutate",
        "cire/host/src/a.ts",
        "--dryRunOnly",
      ],
      cwd: "/repo",
    },
  );
});

test("refusal accepts a cire package that has a config", () => {
  expect(
    refusal("/repo/cire/host", ROOT, (p) => p === "/repo/cire/host/stryker.config.mjs"),
  ).toBeUndefined();
});

test("refusal rejects a directory outside cire/", () => {
  expect(refusal("/repo/osn/api", ROOT, () => true)).toContain("run from a cire package");
});

test("refusal rejects a cire package with no config", () => {
  expect(refusal("/repo/cire/host", ROOT, () => false)).toContain("run from a cire package");
});

test("the CLI exits 2 outside a cire package", async () => {
  const proc = Bun.spawn(["bun", "run", new URL("../stryker-cire.ts", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain("run from a cire package");
});
