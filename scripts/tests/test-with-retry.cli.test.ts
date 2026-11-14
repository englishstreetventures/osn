// scripts/test-with-retry.sh, one test per way it can fail. It wraps CI's
// Scripts and browser test steps: a wrong exit code turns a red tier green, a
// second run of a passing tier doubles the step for nothing, and a missing or
// empty warning lets a flaky test pass the merge queue unseen. Each command
// here is a small bash script standing in for the tier: it counts its runs in
// `<dir>/runs`, prints what the case gives that run, and exits as the case
// says.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case runs bash, retry.sh and one bash per run; the one that waits on a
// limit waits two seconds.
setDefaultTimeout(15_000);

const SCRIPT = join(import.meta.dir, "..", "test-with-retry.sh");

const scratch = mkdtempSync(join(tmpdir(), "test-with-retry-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let next = 0;

/** A working directory of the case's own. */
function dir(): string {
  next += 1;
  return mkdtempSync(join(scratch, `case-${next}-`));
}

interface Run {
  readonly exit: number;
  /** What the run prints, to stderr as bun test does. */
  readonly prints?: string;
}

/**
 * A stand-in for the tier: adds one to `<at>/runs`, prints `runs[n - 1]`'s
 * text and exits with its code (the last run serves every run after it).
 */
function tier(at: string, runs: readonly Run[]): string[] {
  const cases = runs
    .map((run, i) => {
      const body = `printf '%s' ${shellQuote(run.prints ?? "")} >&2; exit ${run.exit}`;
      return i === runs.length - 1 ? `*) ${body} ;;` : `${i + 1}) ${body} ;;`;
    })
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

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const runsIn = (at: string): number =>
  existsSync(join(at, "runs")) ? Number(readFileSync(join(at, "runs"), "utf8").trim()) : 0;

async function attempt(
  at: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly output: string; readonly summary: string }> {
  const summaryFile = join(at, "summary.md");
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: at,
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile, RUNNER_TEMP: at },
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

/** The script's own flake warnings, as opposed to retry.sh's per-attempt ones. */
const flakes = (output: string, label: string): string[] =>
  output.split("\n").filter((line) => line.startsWith(`::warning::${label} passed`));

const ESC = "\u001B";

// What a first run that fails prints: bun's line, Vitest's two through turbo's
// prefix and in colour (Vitest colours its output whenever CI is set), and
// lines that must not be taken for a failure.
const FIRST_RUN = [
  "bun test v1.4.4",
  "(pass) grid > keeps 3×3 cells [0.20ms]",
  "(fail) grid > fills 100% of the row [5001.23ms]",
  `@shared/ui:test:browser: ${ESC}[31m     ${ESC}[31m×${ESC}[31m opens the menu${ESC}[39m 12ms`,
  `@shared/ui:test:browser: ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m tests/menu.browser.test.tsx > opens the menu`,
  "@shared/ui:test:browser:    ✓ draws 3×3 tiles 400ms",
  " 1 fail",
  "",
].join("\n");

describe("test-with-retry.sh", () => {
  test("a tier that passes on its first run runs once, and the step passes with no warning and no summary", async () => {
    const at = dir();
    const { exitCode, output, summary } = await attempt(at, [
      "2",
      "10",
      "Scripts",
      ...tier(at, [{ exit: 0, prints: "(pass) a > b\n" }]),
    ]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 1 });
    expect(output).toContain("(pass) a > b");
    expect(output).not.toContain("::warning::");
    expect(summary).toBe("");
  });

  test("a tier that fails and then passes runs twice, passes the step, and names the first run's failing tests in a warning and the summary", async () => {
    const at = dir();
    const { exitCode, output, summary } = await attempt(at, [
      "2",
      "10",
      "Browser tests (rest)",
      ...tier(at, [
        { exit: 1, prints: FIRST_RUN },
        { exit: 0, prints: "(fail) only the second run printed this\n" },
      ]),
    ]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 2 });
    // Both runs' output stays in the step's log.
    expect(output).toContain("(fail) grid > fills 100% of the row");
    expect(output).toContain("only the second run printed this");
    const flagged = flakes(output, "Browser tests (rest)");
    expect(flagged, output).toHaveLength(1);
    const warning = flagged[0] ?? "";
    expect(warning).toContain("passed on run 2 of 2 after run 1 failed");
    // One annotation line: the failing tests are joined by encoded line ends,
    // and the `%` of a test name is encoded so GitHub does not read it as one.
    expect(warning).toContain("%0A(fail) grid > fills 100%25 of the row [5001.23ms]");
    expect(warning).toContain("%0A@shared/ui:test:browser: × opens the menu 12ms");
    expect(warning).toContain(
      "%0A@shared/ui:test:browser: FAIL tests/menu.browser.test.tsx > opens the menu",
    );
    for (const not of ["3×3", "(pass)", "%0A1 fail", "only the second run", ESC]) {
      expect(warning).not.toContain(not);
    }
    expect(summary).toContain("### Browser tests (rest) passed on run 2 of 2");
    expect(summary).toContain("Run 1 failed first");
    expect(summary).toContain("(fail) grid > fills 100% of the row [5001.23ms]");
    expect(summary).toContain("@shared/ui:test:browser: × opens the menu 12ms");
    expect(summary).not.toContain("3×3");
    expect(summary).not.toContain("only the second run");
    expect(output).not.toContain("::error::");
  });

  test("a pass after a run whose output names no failing test still warns, and says no line named one", async () => {
    const at = dir();
    const { exitCode, output, summary } = await attempt(at, [
      "2",
      "10",
      "Scripts",
      ...tier(at, [{ exit: 1, prints: "error: could not start the server\n" }, { exit: 0 }]),
    ]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 2 });
    const flagged = flakes(output, "Scripts");
    expect(flagged, output).toHaveLength(1);
    expect(flagged[0]).toContain("passed on run 2 of 2 after run 1 failed");
    expect(flagged[0]).toContain("no line of it names a failing test");
    expect(summary).toContain("### Scripts passed on run 2 of 2");
    expect(summary).toContain("no line of it names a failing test");
  });

  test("a first run with more than 40 failing lines puts the first 40 in the warning and the summary, and says how many there were", async () => {
    const at = dir();
    const many = Array.from({ length: 45 }, (_, i) => `(fail) case ${i + 1} [1.00ms]`).join("\n");
    const { exitCode, output, summary } = await attempt(at, [
      "2",
      "10",
      "Scripts",
      ...tier(at, [{ exit: 1, prints: `${many}\n` }, { exit: 0 }]),
    ]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 0, runs: 2 });
    const warning = flakes(output, "Scripts")[0] ?? "";
    expect(warning).toContain("the first 40 of 45");
    expect(warning).toContain("(fail) case 40 [1.00ms]");
    expect(warning).not.toContain("(fail) case 41 ");
    expect(summary).toContain("the first 40 of 45");
    expect(summary).toContain("(fail) case 40 [1.00ms]");
    expect(summary).not.toContain("(fail) case 41 ");
  });

  test("a tier that fails on both runs fails the step with the last run's status, calls nothing a flake, and summarises the last run's failing tests", async () => {
    const at = dir();
    const { exitCode, output, summary } = await attempt(at, [
      "2",
      "10",
      "Scripts",
      ...tier(at, [
        { exit: 3, prints: "(fail) first run only\n" },
        { exit: 4, prints: "(fail) grid > fills the row [2.00ms]\n" },
      ]),
    ]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 4, runs: 2 });
    expect(flakes(output, "Scripts")).toEqual([]);
    expect(output).toContain("::error::");
    expect(summary).toContain("### Scripts: both runs failed");
    expect(summary).toContain("(fail) grid > fills the row [2.00ms]");
  });

  test("a run cut at its limit fails with timeout's 124, through both runs", async () => {
    const at = dir();
    const { exitCode, output } = await attempt(at, [
      "2",
      "1",
      "Scripts",
      "bash",
      "-c",
      `n=$(( $(cat "${at}/runs" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${at}/runs"; sleep 30`,
    ]);
    expect({ exitCode, runs: runsIn(at) }, output).toEqual({ exitCode: 124, runs: 2 });
    expect(flakes(output, "Scripts")).toEqual([]);
  });

  // A missing command must not reach the run with nothing to run, which bash
  // treats as success.
  test.each([
    ["no command", ["2", "10", "Scripts"], false],
    ["an empty label", ["2", "10", ""], true],
    ["attempts that are not a whole number", ["two", "10", "Scripts"], true],
    ["no attempt", ["0", "10", "Scripts"], true],
  ] as const)("%s is a usage error: exit 2, and nothing runs", async (_name, args, command) => {
    const at = dir();
    const { exitCode, output, summary } = await attempt(at, [
      ...args,
      ...(command ? tier(at, [{ exit: 0 }]) : []),
    ]);
    expect(exitCode, output).toBe(2);
    expect(output).toContain("usage:");
    expect(runsIn(at)).toBe(0);
    expect(summary).toBe("");
  });
});
