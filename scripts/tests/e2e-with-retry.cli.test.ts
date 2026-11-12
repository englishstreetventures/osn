// scripts/e2e-with-retry.sh, one test per way it can fail. It is CI's E2E
// step: a wrong exit code turns a red suite green, a lost directory loses the
// failed run's traces, and a missing warning hides a flake behind a green
// check. Each command here is a small bash script standing in for the
// launcher: it counts its runs, clears e2e-artifacts/ as the launcher does,
// writes its run number there, and exits as the case says.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case runs bash, retry.sh and one bash per run; none waits on a limit.
setDefaultTimeout(15_000);

const SCRIPT = join(import.meta.dir, "..", "e2e-with-retry.sh");

const scratch = mkdtempSync(join(tmpdir(), "e2e-with-retry-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let next = 0;

/** A working directory of the case's own, standing in for the checkout. */
function dir(): string {
  next += 1;
  return mkdtempSync(join(scratch, `case-${next}-`));
}

/**
 * A stand-in for the suite: adds one to `<at>/runs`, clears and refills
 * `e2e-artifacts/` with its run number, then exits with `codes[run - 1]`
 * (the last code serves every run after it).
 */
function suite(at: string, codes: readonly number[]): string[] {
  const cases = codes
    .map((code, i) => (i === codes.length - 1 ? `*) exit ${code} ;;` : `${i + 1}) exit ${code} ;;`))
    .join("\n");
  return [
    "bash",
    "-c",
    `n=$(( $(cat "${at}/runs" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${at}/runs"
rm -rf e2e-artifacts && mkdir e2e-artifacts && echo "$n" > e2e-artifacts/run
case "$n" in
${cases}
esac`,
  ];
}

const runsIn = (at: string): number =>
  existsSync(join(at, "runs")) ? Number(readFileSync(join(at, "runs"), "utf8").trim()) : 0;

/** The run number a stand-in left in `<at>/<artifacts>/run`, or null. */
const runIn = (at: string, artifacts: string): number | null => {
  const path = join(at, artifacts, "run");
  return existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : null;
};

async function attempt(
  at: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly output: string; readonly summary: string }> {
  const summaryFile = join(at, "summary.md");
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: at,
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const summary = existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "";
  return { exitCode, output: stdout + stderr, summary };
}

describe("e2e-with-retry.sh", () => {
  test("a suite that passes on its first run runs once, and the step passes with no warning, no summary and no earlier run's directory", async () => {
    const at = dir();
    const { exitCode, output, summary } = await attempt(at, ["2", "10", ...suite(at, [0])]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 1 });
    expect(runIn(at, "e2e-artifacts")).toBe(1);
    expect(existsSync(join(at, "e2e-artifacts-attempt-1"))).toBe(false);
    expect(output).not.toContain("::warning::");
    expect(summary).toBe("");
  });

  test("a suite that fails and then passes runs twice, passes the step, keeps the failed run's artifacts apart and flags the flake", async () => {
    const at = dir();
    const { exitCode, output, summary } = await attempt(at, ["2", "10", ...suite(at, [1, 0])]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 2 });
    // The second run clears e2e-artifacts/ as it starts, so the first run's
    // survive only where the script moved them.
    expect(runIn(at, "e2e-artifacts-attempt-1")).toBe(1);
    expect(runIn(at, "e2e-artifacts")).toBe(2);
    const flagged = output.split("\n").filter((line) => line.startsWith("::warning::E2E "));
    expect(flagged, output).toHaveLength(1);
    expect(flagged[0]).toContain("passed on run 2 of 2");
    expect(flagged[0]).toContain("run 1 failed");
    expect(flagged[0]).toContain("e2e-artifacts-attempt-1");
    expect(summary).toContain("passed on run 2 of 2");
    expect(summary).toContain("Run 1 failed");
    expect(summary).toContain("`e2e-artifacts-attempt-1`");
    expect(output).not.toContain("::error::");
  });

  test("a suite that fails on every run fails the step with the last run's status, and keeps every run's artifacts", async () => {
    const at = dir();
    const { exitCode, output, summary } = await attempt(at, ["2", "10", ...suite(at, [3, 4])]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 4, runs: 2 });
    expect(runIn(at, "e2e-artifacts-attempt-1")).toBe(1);
    expect(runIn(at, "e2e-artifacts")).toBe(2);
    expect(output).toContain("::error::");
    expect(summary).toContain("all 2 runs failed");
    expect(summary).toContain("`e2e-artifacts-attempt-1`");
  });

  test("an earlier invocation's directories are neither uploaded as this one's failed run nor counted as a flake", async () => {
    const at = dir();
    for (const stale of ["e2e-artifacts", "e2e-artifacts-attempt-1"]) {
      mkdirSync(join(at, stale));
      writeFileSync(join(at, stale, "run"), "99\n");
    }
    const { exitCode, output, summary } = await attempt(at, ["2", "10", ...suite(at, [0])]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 1 });
    expect(runIn(at, "e2e-artifacts")).toBe(1);
    expect(existsSync(join(at, "e2e-artifacts-attempt-1"))).toBe(false);
    expect(output).not.toContain("::warning::");
    expect(summary).toBe("");
  });

  // A missing command must not reach `exec` with nothing to run, which bash
  // treats as success.
  test("no command is a usage error: exit 2, and nothing runs", async () => {
    const at = dir();
    const { exitCode, output, summary } = await attempt(at, ["2", "10"]);
    expect(exitCode, output).toBe(2);
    expect(output).toContain("usage:");
    expect(runsIn(at)).toBe(0);
    expect(summary).toBe("");
  });
});
