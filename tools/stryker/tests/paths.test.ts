import { expect, test } from "bun:test";

import { changedMutate, parseMutateEntry, rootMutateEntry } from "../src/paths.ts";

const ROOT = "/repo";

test("rootMutateEntry roots a package-relative entry and keeps its line range", () => {
  expect(rootMutateEntry("src/a.ts:20-48", "cire/vendor", ROOT)).toBe("cire/vendor/src/a.ts:20-48");
});

test("rootMutateEntry keeps an exclusion", () => {
  expect(rootMutateEntry("!src/b.ts", "cire/vendor", ROOT)).toBe("!cire/vendor/src/b.ts");
});

test("rootMutateEntry leaves an entry that is already root-relative", () => {
  expect(rootMutateEntry("cire/api/src/lib/money.ts", "cire/api", ROOT)).toBe(
    "cire/api/src/lib/money.ts",
  );
});

test("rootMutateEntry makes an absolute path root-relative", () => {
  expect(rootMutateEntry("/repo/cire/host/src/a.ts:3-9", "cire/host", ROOT)).toBe(
    "cire/host/src/a.ts:3-9",
  );
  expect(rootMutateEntry("!/repo/cire/host/src/b.ts", "cire/host", ROOT)).toBe(
    "!cire/host/src/b.ts",
  );
});

test("parseMutateEntry trims, and refuses an empty entry", () => {
  expect(parseMutateEntry(" src/a.ts ")).toBe("src/a.ts");
  expect(() => parseMutateEntry("  ")).toThrow("empty");
  expect(() => parseMutateEntry("!")).toThrow("empty");
});

const DIFF = [
  "diff --git a/cire/host/src/lib/a.ts b/cire/host/src/lib/a.ts",
  "--- a/cire/host/src/lib/a.ts",
  "+++ b/cire/host/src/lib/a.ts",
  "@@ -10,2 +10,3 @@ export function a() {",
  "@@ -40 +41 @@",
  "@@ -50,4 +52,0 @@",
  "--- a/cire/host/src/lib/gone.ts",
  "+++ /dev/null",
  "@@ -1,9 +0,0 @@",
  "--- a/cire/host/src/lib/b.test.ts",
  "+++ b/cire/host/src/lib/b.test.ts",
  "@@ -1 +1 @@",
  "--- a/cire/host/src/env.d.ts",
  "+++ b/cire/host/src/env.d.ts",
  "@@ -1 +1 @@",
].join("\n");

test("changedMutate turns added and changed hunks into line ranges and skips pure deletions", () => {
  expect(changedMutate(DIFF, [])).toEqual([
    "cire/host/src/lib/a.ts:10-12",
    "cire/host/src/lib/a.ts:41-41",
  ]);
});

test("changedMutate mutates an untracked source file whole and skips tests and declarations", () => {
  expect(
    changedMutate("", [
      "cire/host/src/lib/new.tsx",
      "cire/host/src/lib/new.test.tsx",
      "cire/host/src/x.d.ts",
    ]),
  ).toEqual(["cire/host/src/lib/new.tsx"]);
});
