// scripts/retry.sh, one test per way it can fail (NEW-FEAT.md R1–R6). It runs
// a CI step whose failure comes from the network or the runner, not the change
// — `playwright install-deps`, whose apt mirror can stall — so a wrong exit
// code turns a red step green or a passing one red, and a process it leaves
// running holds apt's lock against the next attempt. Each command here is a
// small bash script that counts its runs in a file of the test's own.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RETRY = join(import.meta.dir, "..", "retry.sh");

const scratch = mkdtempSync(join(tmpdir(), "retry-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let next = 0;

/** A directory of the test's own, for its run counter and pid files. */
function dir(): string {
  next += 1;
  return mkdtempSync(join(scratch, `case-${next}-`));
}

/**
 * A bash command that adds one to `<at>/runs`, then runs the body `bodies`
 * gives for that run (1-based); the last body serves every run after it.
 */
function counted(at: string, bodies: readonly string[]): string[] {
  const cases = bodies
    .map((body, i) => (i === bodies.length - 1 ? `*) ${body} ;;` : `${i + 1}) ${body} ;;`))
    .join("\n");
  return [
    "bash",
    "-c",
    `n=$(( $(cat "${at}/runs" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${at}/runs"
case "$n" in
${cases}
esac`,
  ];
}

const runsIn = (at: string): number => Number(readFileSync(join(at, "runs"), "utf8").trim());

async function retry(
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly output: string; readonly ms: number }> {
  const from = performance.now();
  const proc = Bun.spawn(["bash", RETRY, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: stdout + stderr, ms: performance.now() - from };
}

/** Whether a process with this pid is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("retry.sh", () => {
  test("R1: a command that passes on its first attempt runs once, and the script exits 0 with no warning", async () => {
    const at = dir();
    const { exitCode, output } = await retry(["3", "10", ...counted(at, ["exit 0"])]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 1 });
    expect(output).not.toContain("::warning::");
    expect(output).not.toContain("::error::");
  });

  test("R2: a command that fails and then passes runs twice, exits 0, and the warning names the failed attempt and its status", async () => {
    const at = dir();
    const { exitCode, output } = await retry(["3", "10", ...counted(at, ["exit 3", "exit 0"])]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 2 });
    expect(output).toContain("::warning::");
    expect(output).toContain("attempt 1 of 3");
    expect(output).toContain("exited 3");
    expect(output).not.toContain("attempt 2 of 3");
    expect(output).not.toContain("::error::");
  });

  test("R3: a command that always fails runs exactly as many times as allowed, and the script exits with its last status", async () => {
    const at = dir();
    const { exitCode, output } = await retry(["3", "10", ...counted(at, ["exit 4", "exit 5"])]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 5, runs: 3 });
    expect(output).toContain("::error::");
  });

  test("R4: an attempt that hangs and ignores SIGTERM is killed at its limit plus the grace, and the next attempt runs", async () => {
    const at = dir();
    const { exitCode, output, ms } = await retry([
      "-k",
      "1",
      "2",
      "1",
      ...counted(at, [`trap '' TERM; echo $$ > "${at}/hung"; sleep 30`, "exit 0"]),
    ]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 2 });
    expect(output).toContain("attempt 1 of 2");
    expect(output).toContain("cut at its 1 s limit");
    expect(alive(Number(readFileSync(join(at, "hung"), "utf8")))).toBe(false);
    // One second's limit and one second's grace, well short of the 30 s sleep.
    expect(ms).toBeLessThan(10_000);
  });

  test("R6: a process an attempt started that ignores SIGTERM and outlives the attempt is killed before the next attempt runs", async () => {
    const at = dir();
    // The attempt's own shell dies at the limit; its child, which ignores
    // SIGTERM, would keep running (as an apt-get holding its lock would).
    const { exitCode, output } = await retry([
      "-k",
      "1",
      "2",
      "1",
      ...counted(at, [
        `(trap '' TERM; exec sleep 30) & echo $! > "${at}/child"; sleep 30`,
        `if kill -0 "$(cat "${at}/child")" 2>/dev/null; then exit 7; fi; exit 0`,
      ]),
    ]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 2 });
    expect(alive(Number(readFileSync(join(at, "child"), "utf8")))).toBe(false);
  });

  // CMD stands for a command that leaves a file behind if it runs.
  test.each([
    ["no command", ["3", "10"]],
    ["attempts that are not a number", ["three", "10", "CMD"]],
    ["zero attempts", ["0", "10", "CMD"]],
    ["seconds that are not a whole number", ["3", "1.5", "CMD"]],
    ["zero seconds, which would mean no limit", ["3", "0", "CMD"]],
    ["a grace that is not a number", ["-k", "soon", "3", "10", "CMD"]],
    ["-k with nothing after it", ["-k"]],
  ] as const)("R5: %s is a usage error, exit 2, and nothing runs", async (_, args) => {
    const ran = join(dir(), "ran");
    const { exitCode, output } = await retry(
      args.flatMap((one) => (one === "CMD" ? ["bash", "-c", `touch "${ran}"`] : [one])),
    );
    expect(exitCode, output).toBe(2);
    expect(output).toContain("usage: retry.sh");
    expect(existsSync(ran)).toBe(false);
  });
});
