// Tests live in `tests/` at each package root, never under `src/`. A test
// left under `src/` either runs where nobody looks for it or runs nowhere
// while reading as coverage, and neither turns a check red, so
// check-tests-outside-src.ts does. These run it as a subprocess against
// fixture repository roots, the way check-astro-test-routes.cli.test.ts does.
//
// `TESTS_OUTSIDE_SRC_ROOT` points the script at a fixture root instead of the
// real repository; CI never sets it. The last test runs with it unset, against
// this checkout.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = new URL("../check-tests-outside-src.ts", import.meta.url).pathname;
const SUCCESS_LINE = "check-tests-outside-src: no test or spec file under src/";

async function runCli(
  root: string | undefined,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const env = { ...Bun.env };
  delete env.TESTS_OUTSIDE_SRC_ROOT;
  if (root !== undefined) env.TESTS_OUTSIDE_SRC_ROOT = root;
  const proc = Bun.spawn([process.execPath, "run", SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** A fixture root holding `files` (path → contents), each written with its parent dirs. */
async function withFixtureRoot(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tests-outside-src-cli-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// One glob pattern and one literal path, the two shapes the root
// package.json's `workspaces` holds.
const WORKSPACES = {
  "package.json": JSON.stringify({ name: "fixture", workspaces: ["pkgs/*", "tools/one"] }),
  "pkgs/a/package.json": JSON.stringify({ name: "a" }),
  "pkgs/b/package.json": JSON.stringify({ name: "b" }),
  "tools/one/package.json": JSON.stringify({ name: "one" }),
};

test("exits non-zero naming each test file under a workspace's src/", async () => {
  await withFixtureRoot(
    {
      ...WORKSPACES,
      "pkgs/a/src/x.test.ts": "",
      // Two-part suffix: a Vitest project that includes only tests/** never
      // collects it, so it reads as coverage and runs nowhere.
      "tools/one/src/lib/Panel.browser.test.tsx": "",
      // `bun test` collects the underscore form too.
      "pkgs/b/src/util_test.ts": "",
    },
    async (root) => {
      const { exitCode, stdout, stderr } = await runCli(root);
      expect(stderr).toContain("pkgs/a/src/x.test.ts");
      expect(stderr).toContain("tools/one/src/lib/Panel.browser.test.tsx");
      expect(stderr).toContain("pkgs/b/src/util_test.ts");
      expect(stdout).not.toContain(SUCCESS_LINE);
      expect(exitCode).not.toBe(0);
    },
  );
});

test("exits 0 when tests sit in tests/ and src/ holds only source", async () => {
  await withFixtureRoot(
    {
      ...WORKSPACES,
      "pkgs/a/src/index.ts": "",
      // A source name that merely contains the word.
      "pkgs/a/src/latest.ts": "",
      "pkgs/a/tests/x.test.ts": "",
      "tools/one/src/lib/util.ts": "",
      // pkgs/b has no src/ at all.
    },
    async (root) => {
      const { exitCode, stdout, stderr } = await runCli(root);
      expect(stderr).toBe("");
      expect(stdout).toContain(`${SUCCESS_LINE} in 3 workspaces`);
      expect(exitCode).toBe(0);
    },
  );
});

// Each of these leaves the check with nothing it can walk. Printing success
// after checking nothing would be a pass that proves nothing.
test.each([
  ["a pattern that matches no workspace", { workspaces: ["nothing/*"] }],
  ["a workspaces value that is not a list", { workspaces: "pkgs/*" }],
  ["a negated pattern", { workspaces: ["pkgs/*", "!pkgs/b"] }],
])("exits non-zero on %s", async (_label, manifest) => {
  await withFixtureRoot(
    { ...WORKSPACES, "package.json": JSON.stringify({ name: "fixture", ...manifest }) },
    async (root) => {
      const { exitCode, stdout, stderr } = await runCli(root);
      expect(stderr).toContain("::error::check-tests-outside-src");
      expect(stdout).not.toContain(SUCCESS_LINE);
      expect(exitCode).not.toBe(0);
    },
  );
});

// The walk does not follow links, so it cannot see what sits behind one.
test("exits non-zero on a symlinked directory under src/", async () => {
  await withFixtureRoot({ ...WORKSPACES, "pkgs/a/elsewhere/x.test.ts": "" }, async (root) => {
    await mkdir(join(root, "pkgs/a/src"), { recursive: true });
    await symlink(join(root, "pkgs/a/elsewhere"), join(root, "pkgs/a/src/linked"));
    const { exitCode, stderr } = await runCli(root);
    expect(stderr).toContain("pkgs/a/src/linked");
    expect(stderr).toContain("symlink");
    expect(exitCode).not.toBe(0);
  });
});

// Every other test sets the override. This one resolves the default root from
// the script's own location, the join a move of scripts/ would break.
test("exits 0 on this repository with no override set", async () => {
  const { exitCode, stdout, stderr } = await runCli(undefined);
  expect(stderr).toBe("");
  expect(stdout).toContain(SUCCESS_LINE);
  expect(exitCode).toBe(0);
});
