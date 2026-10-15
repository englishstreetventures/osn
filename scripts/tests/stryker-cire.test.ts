// `scripts/stryker-cire.ts` runs Stryker from the repo root, so the package-
// relative `--mutate` paths a person types from `cire/<pkg>` must be rewritten
// to root-relative ones, or Stryker finds nothing to mutate and says so only as
// "Found 0 of N file(s) to be mutated".

import { expect, test } from "bun:test";

import { rewriteArgs, rewriteMutate } from "../stryker-cire";

test("rewriteMutate roots each comma-separated entry at the package", () => {
  expect(rewriteMutate("src/a.ts,src/b.tsx", "cire/host")).toBe(
    "cire/host/src/a.ts,cire/host/src/b.tsx",
  );
});

test("rewriteMutate keeps a line range and an exclusion", () => {
  expect(rewriteMutate("src/a.ts:20-48,!src/b.ts", "cire/vendor")).toBe(
    "cire/vendor/src/a.ts:20-48,!cire/vendor/src/b.ts",
  );
});

test("rewriteMutate leaves an entry that is already root-relative", () => {
  expect(rewriteMutate("cire/api/src/lib/money.ts", "cire/api")).toBe("cire/api/src/lib/money.ts");
});

test("rewriteArgs rewrites --mutate, -m and --mutate= and passes the rest through", () => {
  expect(
    rewriteArgs(
      ["--mutate", "src/a.ts", "--concurrency", "2", "-m", "src/b.ts", "--mutate=src/c.ts"],
      "cire/ui",
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
  expect(rewriteArgs(["--mutate"], "cire/ui")).toEqual(["--mutate"]);
});

test("the CLI refuses to run outside a cire package", async () => {
  const proc = Bun.spawn(["bun", "run", new URL("../stryker-cire.ts", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain("run from a cire package");
});
