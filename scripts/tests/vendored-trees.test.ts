// Holds scripts/vendored-trees.txt to the vendored trees in the repository,
// and CI's script-tests job to the list.
//
// The list is what CI verifies. A tree with a SHA256SUMS that the list leaves
// out is never checked, and a listed tree whose manifest is gone fails the
// guard; each test below fails on one of those before CI would run the guard
// on the wrong set.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface Step {
  readonly name?: string;
  readonly run?: string;
}

interface Workflow {
  readonly jobs: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
}

const root = join(import.meta.dir, "..", "..");

const listed = readFileSync(join(root, "scripts", "vendored-trees.txt"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

const manifests = Bun.spawnSync(["git", "ls-files", "--", "*/SHA256SUMS"], { cwd: root })
  .stdout.toString()
  .split("\n")
  .filter((line) => line !== "");

test("lists the anti-slop plugin and the orb engine", () => {
  expect(listed).toEqual(
    expect.arrayContaining(["tools/oxlint/anti-slop", "shared/ui/vendor/thinking-orbs"]),
  );
});

test("every tracked SHA256SUMS belongs to a listed tree", () => {
  expect(manifests.length).toBeGreaterThan(0);
  const unlisted = manifests.map((path) => dirname(path)).filter((tree) => !listed.includes(tree));
  expect(unlisted).toEqual([]);
});

test("every listed tree has a tracked SHA256SUMS", () => {
  const missing = listed.filter((tree) => !manifests.includes(`${tree}/SHA256SUMS`));
  expect(missing).toEqual([]);
});

test("script-tests verifies the listed trees on pushes and on pull requests, and fails on an empty list", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"),
  ) as Workflow;
  const verifying = (workflow.jobs["script-tests"]?.steps ?? []).filter(
    (step) => step.run?.includes("bash scripts/verify-vendored.sh") === true,
  );
  expect(verifying.map((step) => step.name)).toEqual([
    "Verify vendored trees match their checksums",
    "Verify vendored trees match their checksums and pins",
  ]);
  for (const step of verifying) {
    expect(step.run).toContain("scripts/vendored-trees.txt");
    expect(step.run).toContain("lists no tree");
    expect(step.run).not.toContain("ls-files");
  }
});
