// The tests beside this one call the check functions directly and never run
// the `import.meta.main` block that lists the tracked files with git. These
// run the script itself, the way `bun run check:alchemy-usage` and the
// `script-tests` CI job do. CI's "Check Alchemy usage" step runs it on the
// committed tree.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = new URL("../check-alchemy-usage.ts", import.meta.url).pathname;

const scratch = mkdtempSync(join(tmpdir(), "check-alchemy-usage-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function runCli(
  script: string,
  env: Readonly<Record<string, string>>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("the CLI exits 1 and says nothing was checked when git cannot list the tracked files", async () => {
  const { exitCode, stdout, stderr } = await runCli(SCRIPT, { GIT_DIR: "/nonexistent" });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("nothing was checked");
  expect(stdout).toBe("");
});

test("the CLI exits 1 and says nothing was checked when git exits 0 but lists nothing", async () => {
  const { exitCode, stdout, stderr } = await runCli(SCRIPT, {
    GIT_INDEX_FILE: join(scratch, "no-such-index"),
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("nothing was checked");
  expect(stdout).toBe("");
});

test("the CLI exits 1 and names every tracked file with a finding", async () => {
  const repo = join(scratch, "repo");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "root", scripts: {} }),
    "pkg/package.json": JSON.stringify({ name: "pkg", scripts: { x: "bun alchemy deploy" } }),
    ".github/workflows/w.yml": [
      "on: workflow_dispatch",
      "env:",
      '  DO_NOT_TRACK: "1"',
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bunx alchemy state read x",
      "",
    ].join("\n"),
    ".github/actions/a/action.yml": [
      "runs:",
      "  using: composite",
      "  steps:",
      "    - shell: bash",
      "      run: bunx alchemy deploy",
      "",
    ].join("\n"),
    "foo/infra/alchemy.run.ts": "const state = localState();\n",
    "foo/infra/src/db.ts": "const state = makeLocalState();\n",
    "foo/infra/tests/db.test.ts": "const state = localState();\n",
    "untracked/infra/alchemy.run.ts": "const state = localState();\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  mkdirSync(join(repo, "scripts"));
  copyFileSync(SCRIPT, join(repo, "scripts/check-alchemy-usage.ts"));
  const tracked = Object.keys(files).filter((path) => !path.startsWith("untracked/"));
  for (const args of [
    ["init", "-q"],
    ["add", "--", ...tracked],
  ]) {
    expect(spawnSync("git", args, { cwd: repo }).status).toBe(0);
  }

  const { exitCode, stdout, stderr } = await runCli(
    join(repo, "scripts/check-alchemy-usage.ts"),
    {},
  );

  expect(exitCode).toBe(1);
  expect(stdout).toBe("check-alchemy-usage: 5 finding(s).\n");
  for (const path of [
    "pkg/package.json scripts.x",
    ".github/workflows/w.yml jobs.a",
    ".github/actions/a/action.yml runs",
    "foo/infra/alchemy.run.ts",
    "foo/infra/src/db.ts",
  ]) {
    expect(stderr).toContain(path);
  }
  expect(stderr).not.toContain("tests/db.test.ts");
  expect(stderr).not.toContain("untracked/");
});
