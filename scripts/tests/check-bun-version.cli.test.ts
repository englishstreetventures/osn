// A local Bun that differs from `.bun-version` can fail a test that is green
// in CI, which installs the pinned version, and the failure looks like a
// regression. The SessionStart hook in .claude/settings.json runs
// scripts/check-bun-version.sh so a session hears about the skew before it
// trusts such a failure.
//
// These run the hook's command exactly as settings.json holds it, so a hook
// that no longer reaches the script (its `|| true` would hide that) fails here.
// A stand-in `bun` on PATH prints whatever version a test needs; the pin is
// the real `.bun-version`.

import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const BASH = "/bin/bash";

interface HookGroup {
  readonly hooks: readonly { readonly command: string }[];
}

async function hookCommand(): Promise<string> {
  const settings = JSON.parse(await readFile(join(REPO_ROOT, ".claude/settings.json"), "utf8")) as {
    hooks: { SessionStart: readonly HookGroup[] };
  };
  const command = settings.hooks.SessionStart.flatMap((group) => group.hooks)
    .map((hook) => hook.command)
    .find((c) => c.includes("check-bun-version.sh"));
  if (command === undefined) throw new Error("no SessionStart hook runs check-bun-version.sh");
  return command;
}

async function pinned(): Promise<string> {
  return (await readFile(join(REPO_ROOT, ".bun-version"), "utf8")).trim();
}

/** Runs the hook with only `binDir`, /usr/bin and /bin on PATH. */
async function withBin(
  bunVersion: string | null,
  run: (env: Record<string, string>) => Promise<void>,
): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), "check-bun-version-"));
  try {
    if (bunVersion !== null) {
      const stand = join(binDir, "bun");
      await writeFile(stand, `#!/bin/sh\necho ${bunVersion}\n`);
      await chmod(stand, 0o755);
    }
    await run({ PATH: `${binDir}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: REPO_ROOT });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

async function runShell(
  command: string,
  env: Record<string, string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn([BASH, "-c", command], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("the hook names both versions when the Bun on PATH differs from the pin", async () => {
  const pin = await pinned();
  await withBin("0.0.0-skew", async (env) => {
    const { exitCode, stdout } = await runShell(await hookCommand(), env);
    expect(stdout).toContain("0.0.0-skew");
    expect(stdout).toContain(pin);
    expect(exitCode).toBe(0);
  });
});

test("the hook prints nothing when the Bun on PATH is the pinned one", async () => {
  await withBin(await pinned(), async (env) => {
    const { exitCode, stdout } = await runShell(await hookCommand(), env);
    expect(stdout).toBe("");
    expect(exitCode).toBe(0);
  });
});

test("the hook says Bun is missing, and still exits 0, when no bun is on PATH", async () => {
  const pin = await pinned();
  await withBin(null, async (env) => {
    // A host with /usr/bin/bun cannot show this case; the test must not pass
    // there for the wrong reason.
    const probe = await runShell("command -v bun", env);
    expect(probe.exitCode).not.toBe(0);

    const { exitCode, stdout } = await runShell(await hookCommand(), env);
    expect(stdout).toContain("not on PATH");
    expect(stdout).toContain(pin);
    expect(exitCode).toBe(0);
  });
});
