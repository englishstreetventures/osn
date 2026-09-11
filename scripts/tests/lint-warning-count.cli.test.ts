// The pure-function tests in lint-warning-count.test.ts import
// countWarnings() directly, so none of them exercise the import.meta.main
// block that scripts/guard-lint-warnings.sh actually calls:
// `bun scripts/lint-warning-count.ts <path>`. These tests run the real
// script as a subprocess, the same way scripts/tests/cire-dev-db-guard.cli.test.ts
// does, against a hand-written fixture JSON file shaped like a real oxlint
// `--format=json` report — no oxlint invocation, so this needs no
// `bun install` (matches every other file under scripts/).

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../lint-warning-count.ts", import.meta.url).pathname;

async function runCli(
  ...args: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function withFixtureJson(
  contents: string,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lint-warning-count-cli-"));
  try {
    const path = join(dir, "report.json");
    await writeFile(path, contents);
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("prints the total on the first line, then one rule/count line per rule", async () => {
  await withFixtureJson(
    JSON.stringify({
      diagnostics: [
        { severity: "warning", code: "eslint(no-console)" },
        { severity: "warning", code: "eslint(no-console)" },
        { severity: "error", code: "eslint(no-debugger)" },
      ],
    }),
    async (path) => {
      const { exitCode, stdout } = await runCli(path);
      expect(stdout).toBe("2\neslint(no-console) 2\n");
      expect(exitCode).toBe(0);
    },
  );
});

test("a report with zero warnings prints just the total", async () => {
  await withFixtureJson(JSON.stringify({ diagnostics: [] }), async (path) => {
    const { exitCode, stdout } = await runCli(path);
    expect(stdout).toBe("0\n");
    expect(exitCode).toBe(0);
  });
});

test("exits non-zero when the file does not exist", async () => {
  const { exitCode, stderr } = await runCli("/no/such/file.json");
  expect(stderr).toContain("could not read");
  expect(exitCode).not.toBe(0);
});

test("exits non-zero when the file is not valid JSON", async () => {
  await withFixtureJson("not json", async (path) => {
    const { exitCode, stderr } = await runCli(path);
    expect(stderr).toContain("not valid JSON");
    expect(exitCode).not.toBe(0);
  });
});

test("exits non-zero with a usage message when no path argument is given", async () => {
  const { exitCode, stderr } = await runCli();
  expect(stderr).toContain("usage:");
  expect(exitCode).not.toBe(0);
});
