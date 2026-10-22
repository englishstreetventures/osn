// Runs scripts/check-free-tier-ceilings.ts as a process, the way
// free-tier-ceiling-alert.yml does: `bun run scripts/check-free-tier-ceilings.ts
// --account <production|dev> …` from the repository root. These pin the exit
// code for a call that names no account, or one the alert does not know, which
// must be refused before any credential is read or any request sent.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

const home = mkdtempSync(join(tmpdir(), "free-tier-ceilings-cli-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

// No Cloudflare credential at all: a script that read one before checking the
// account would exit 1 naming CLOUDFLARE_API_TOKEN, not 2 naming --account.
async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "scripts/check-free-tier-ceilings.ts", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("F3: a call with no --account exits 2, naming the flag", async () => {
  const result = await run(["--days", "2"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("--account");
  expect(result.stderr).not.toContain("CLOUDFLARE_API_TOKEN");
});

test("F3: --account with no value exits 2", async () => {
  const result = await run(["--account"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("--account");
});

test("F3: an account the alert does not watch exits 2, naming it", async () => {
  const result = await run(["--account", "staging"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("staging");
});
