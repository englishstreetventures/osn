// The pure-function tests in cire-db-migrate.test.ts never run the
// `import.meta.main` block that cire/db's `db:push` and `db:migrate:*` scripts
// invoke. These run the real script as a subprocess for the calls it must
// refuse before it reaches wrangler: a missing database name, and a target that
// is neither --local nor --remote. A refusal that exited 0 would let the
// package script carry on as if migrations had applied.
//
// Calls that do reach wrangler need a D1 database, local or remote, so they are
// not run here.

import { expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "cire-db-migrate.ts");

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

test("the real CLI exits non-zero with no arguments", async () => {
  const { exitCode, stdout, stderr } = await runCli();
  expect(stdout).toBe("");
  expect(stderr).toContain(
    "::error::cire-db-migrate: the first argument must be the database name",
  );
  expect(exitCode).not.toBe(0);
});

test("the real CLI exits non-zero when the target is neither --local nor --remote", async () => {
  const { exitCode, stdout, stderr } = await runCli("cire-db", "--env", "production");
  expect(stdout).toBe("");
  expect(stderr).toContain("pass exactly one of --local or --remote");
  expect(exitCode).not.toBe(0);
});
