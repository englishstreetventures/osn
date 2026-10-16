#!/usr/bin/env bun
/**
 * Compares the secret inventory and the tier's account credentials with the
 * secret names in one tier's GitHub Environment:
 * `bun run secrets:check-github -- --tier <dev|production>`. Reads names
 * only. Needs a `gh` login that can list Environment secrets. Exits 0 when
 * nothing required is missing and the Environment holds none of the other
 * tier's credentials, 1 otherwise, 2 when the arguments or `gh` fail. A name
 * that is neither a Worker secret nor one of the tier's credentials is
 * printed but does not fail the check.
 */
import { spawnSync } from "node:child_process";

import { formatDiffs, githubDiff, parseTierArgument } from "../src/secrets/compare";
import type { Tier } from "../src/stage";

function gh(args: readonly string[]): string {
  const run = spawnSync("gh", args, { encoding: "utf8" });
  if (run.status !== 0) {
    process.stderr.write(`gh ${args.join(" ")} exited ${run.status}\n${run.stderr}`);
    process.exit(2);
  }
  return run.stdout;
}

let tier: Tier;
try {
  tier = parseTierArgument(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
const diff = githubDiff(
  tier,
  gh(["api", "--paginate", `repos/${repo}/environments/${tier}/secrets`, "--jq", ".secrets[].name"])
    .split("\n")
    .filter((name) => name !== ""),
);
process.stdout.write(formatDiffs([diff]));
process.exit(diff.missing.length === 0 && diff.forbidden.length === 0 ? 0 : 1);
