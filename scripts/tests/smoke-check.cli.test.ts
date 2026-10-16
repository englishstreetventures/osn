// Runs scripts/smoke-check.ts as a process, the way the workflows' smoke step
// does: `bun run scripts/smoke-check.ts <surface> <tier>` from the repository
// root. The exit code is the step's verdict, so these pin it for the cases
// that decide before any request — a bad call, the dry run aimed at
// production, and the guest site's dev check with no Access token. The
// request-and-rollback paths run in smoke-check.test.ts, against a fake fetch.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

// A home with no stored login, and a Cloudflare token that is set but valid
// nowhere: should one of these cases ever get as far as a rollback, the
// Cloudflare API refuses it instead of acting with whoever is logged in on
// this machine.
const home = mkdtempSync(join(tmpdir(), "smoke-check-cli-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", "scripts/smoke-check.ts", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CLOUDFLARE_API_TOKEN: "smoke-check-cli-test-not-a-token",
      CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
      ...env,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("a call with no tier exits 2 with an annotation", async () => {
  const result = await run(["osn_api"]);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toContain("::error::smoke-check: usage");
});

test("a surface that is not a Worker exits 2", async () => {
  const result = await run(["osn_social", "production"]);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toContain("is not a Worker surface");
});

test("the dry run aimed at production exits 2 before asking anything", async () => {
  const result = await run(["osn_api", "production"], { SMOKE_FORCE_FAIL: "true" });
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toContain("the dry run never rolls production back");
});

test("the guest site's dev check with no Access token is skipped, and the step passes", async () => {
  const result = await run(["cire_invites", "dev"], { SMOKE_FORCE_FAIL: "false" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("::warning::Smoke check skipped for cire_invites (dev)");
});
