// The tests beside this one feed `checkAuditIgnores` synthetic YAML and never
// run the `import.meta.main` block that reads the real `lefthook.yml`. These run
// the script itself, the way the `audit-ignores` pre-push command and the
// `script-tests` CI job do.
//
// The script reads `../lefthook.yml` relative to its own file, so a copy at
// `<tmp>/scripts/check-audit-ignores.ts` reads `<tmp>/lefthook.yml`. The script
// imports nothing local, so the copy runs on its own.

import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_SCRIPT = new URL("../check-audit-ignores.ts", import.meta.url).pathname;

/** A date `days` from today, so the fixtures do not expire on the calendar. */
function daysFromToday(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function fixture(markerDate: string): string {
  return `pre-push:
  commands:
    audit:
      # DROP AFTER GHSA-vfj7-8cjw-p6xm ${markerDate}
      run: >
        bun audit --audit-level=high
        --ignore=GHSA-vfj7-8cjw-p6xm
`;
}

async function runCli(
  lefthook: string | null,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "audit-ignores-cli-"));

  try {
    if (lefthook !== null) await writeFile(join(dir, "lefthook.yml"), lefthook);
    await mkdir(join(dir, "scripts"));
    const copied = join(dir, "scripts", "check-audit-ignores.ts");
    await cp(REAL_SCRIPT, copied);

    const proc = Bun.spawn(["bun", "run", copied], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the CLI exits 0 when every ignore carries a marker in date", async () => {
  const { exitCode, stdout, stderr } = await runCli(fixture(daysFromToday(30)));

  expect(stderr).toBe("");
  expect(stdout).toContain("passes the audit-ignore guard");
  expect(exitCode).toBe(0);
});

test("the CLI exits 1 and names the advisory once its marker has passed", async () => {
  const { exitCode, stdout, stderr } = await runCli(fixture(daysFromToday(-1)));

  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("GHSA-vfj7-8cjw-p6xm");
  expect(stderr).toContain("has passed");
  expect(stderr).toContain("repeat the reachability check");
});

test("the CLI exits 1 when lefthook.yml is missing", async () => {
  const { exitCode, stderr } = await runCli(null);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("lefthook.yml not found");
});
