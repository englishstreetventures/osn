// S-H1 — the pure function tests above import `checkReleaseAgeExcludes` and feed
// it synthetic TOML strings; they never exercise the `import.meta.main` CLI
// block, so they proved nothing about whether the real binary reads a real
// `bunfig.toml`. These tests run the actual script file as a subprocess
// against a fixture `bunfig.toml`, the same way `bun run
// check:release-age-excludes` and the `script-tests` CI job invoke it.
//
// The script resolves its target as `../bunfig.toml` relative to its own
// file (`new URL("../bunfig.toml", import.meta.url)`), so a copy of the
// script placed at `<tmp>/scripts/check-release-age-excludes.ts` reads
// `<tmp>/bunfig.toml` — letting this test point the real, unmodified script
// at a throwaway fixture instead of the repo's own `bunfig.toml`.

import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_SCRIPT = new URL("./check-release-age-excludes.ts", import.meta.url).pathname;

async function runCliAgainst(
  bunfigContents: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "release-age-excludes-cli-"));

  try {
    await writeFile(join(dir, "bunfig.toml"), bunfigContents);
    const scriptsDir = join(dir, "scripts");
    await mkdir(scriptsDir);
    const copiedScript = join(scriptsDir, "check-release-age-excludes.ts");
    await cp(REAL_SCRIPT, copiedScript);

    const proc = Bun.spawn(["bun", "run", copiedScript], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

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

test("the real CLI exits 0 against a clean fixture bunfig.toml", async () => {
  const { exitCode, stdout, stderr } = await runCliAgainst(`
[install]
minimumReleaseAge = 259200
minimumReleaseAgeExcludes = []
`);

  expect(stderr).toBe("");
  expect(stdout).toContain("passes the release-age guard");
  expect(exitCode).toBe(0);
});

test("the real CLI exits non-zero against a fixture bunfig.toml with an unmarked exclude", async () => {
  const { exitCode, stdout, stderr } = await runCliAgainst(`
[install]
minimumReleaseAge = 259200
minimumReleaseAgeExcludes = ["left-pad"]
`);

  expect(exitCode).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("left-pad");
  expect(stderr).toContain('no "# DROP AFTER left-pad <YYYY-MM-DD>" marker comment found');
});

test("the real CLI exits non-zero when bunfig.toml is missing entirely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-age-excludes-cli-missing-"));

  try {
    const scriptsDir = join(dir, "scripts");
    await mkdir(scriptsDir);
    await cp(REAL_SCRIPT, join(scriptsDir, "check-release-age-excludes.ts"));

    const proc = Bun.spawn(["bun", "run", join(scriptsDir, "check-release-age-excludes.ts")], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("bunfig.toml not found");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
