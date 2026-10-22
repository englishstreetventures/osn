import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { githubExpectations } from "../src/secrets/compare";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

/** The only `gh` call the dev check may make: the dev Environment's secret names. */
const DEV_LISTING = [
  "api",
  "--paginate",
  "repos/{owner}/{repo}/environments/dev/secrets",
  "--jq",
  ".secrets[].name",
].join(" ");

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `bun run secrets:check-github -- --tier dev` with a fake `gh` first on
 * PATH that prints `names` for the dev listing and refuses any other call.
 * HOME is the temp directory, so no real `gh` login is in reach.
 */
function checkDev(names: readonly string[]): Run {
  const dir = mkdtempSync(join(tmpdir(), "check-github-secrets-"));
  const list = join(dir, "names");
  writeFileSync(list, names.map((name) => `${name}\n`).join(""));
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      `if [ "$*" = '${DEV_LISTING}' ]; then cat '${list}'; exit 0; fi`,
      'echo "unexpected gh call: $*" >&2',
      "exit 3",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = Bun.spawnSync(["bun", "run", "secrets:check-github", "--", "--tier", "dev"], {
    cwd: PACKAGE,
    env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: dir },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("secrets:check-github -- --tier dev", () => {
  test("R0: exits 0 when the dev Environment holds exactly what it must", () => {
    const run = checkDev(githubExpectations("dev"));
    expect(run.stderr).not.toContain("unexpected gh call");
    expect(run.stdout).toBe("ok    GitHub Environment dev\n");
    expect(run.exitCode).toBe(0);
  });

  // Both names reach the production account, and the dev Environment has no
  // reviewer: a copy put back there would let any workflow on main write
  // production.
  test.each(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN_DEV"])(
    "R1: exits 1 when the dev Environment holds %s again, naming it",
    (name) => {
      const run = checkDev([...githubExpectations("dev"), name]);
      expect(run.stdout).toBe(`DIFF  GitHub Environment dev — forbidden but set: ${name}\n`);
      expect(run.exitCode).toBe(1);
    },
  );
});
