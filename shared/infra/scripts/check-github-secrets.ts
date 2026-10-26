#!/usr/bin/env bun
/**
 * Compares what one tier's GitHub Environment must hold with the secret names
 * it does hold: `bun run secrets:check-github -- --tier <dev|production>`.
 * It must hold every required Worker secret in the inventory, the tier's
 * required credentials and the secrets only its workflows read
 * (`WORKFLOW_SECRETS`). Reads names only, so it cannot tell which account a
 * token belongs to. Needs a `gh` login that can list Environment secrets, run
 * inside the repository (or with GH_REPO set) so `gh` fills in
 * `{owner}/{repo}`. Exits 0 when nothing required is missing and the
 * Environment holds no forbidden credential (the other tier's, or a retired
 * dev one), 1 otherwise, 2 when the arguments or `gh` fail. A name it does
 * not know is printed but does not fail the check. It lists Environment
 * secrets only, never repository-level ones. The rules are in
 * `src/secrets/check.ts` (`checkGithub`).
 */
import { spawnSync } from "node:child_process";

import { checkGithub, githubSecretNamesArgs } from "../src/secrets/check";
import { parseTierArgument } from "../src/secrets/compare";
import type { Tier } from "../src/stage";

let tier: Tier;
try {
  tier = parseTierArgument(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const outcome = await checkGithub(tier, () => {
  const run = spawnSync("gh", githubSecretNamesArgs(tier), { encoding: "utf8" });
  return Promise.resolve(
    run.error === undefined && run.status !== null
      ? { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" }
      : {
          status: null,
          stdout: "",
          stderr: "",
          startError: run.error?.message ?? `killed by ${run.signal ?? "a signal"}`,
        },
  );
});
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exit(outcome.exitCode);
