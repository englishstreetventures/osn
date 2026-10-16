// The tests beside this one call the check functions directly and never run
// the `import.meta.main` block that lists the tracked files with git. These
// run the script itself, the way `bun run check:alchemy-usage` and the
// `script-tests` CI job do.

import { expect, test } from "bun:test";

const SCRIPT = new URL("../check-alchemy-usage.ts", import.meta.url).pathname;

async function runCli(
  env: Readonly<Record<string, string>>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT], {
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
  const { exitCode, stdout, stderr } = await runCli({ GIT_DIR: "/nonexistent" });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("nothing was checked");
  expect(stdout).toBe("");
});

test("the CLI exits 0 on the committed tree", async () => {
  const { exitCode, stdout, stderr } = await runCli({});

  expect(stderr).toBe("");
  expect(stdout).toContain("every Alchemy use passes");
  expect(exitCode).toBe(0);
});
