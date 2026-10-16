#!/usr/bin/env bun
/**
 * Compares the secret inventory with the secret names each live Worker of one
 * tier holds: `CLOUDFLARE_ACCOUNT_ID=<id> bun run secrets:check-live -- --tier
 * <dev|production>`. Reads names only: `wrangler secret list` never returns a
 * value. CLOUDFLARE_ACCOUNT_ID names the account that serves the tier's
 * Workers and is required; credentials come from a `wrangler login` or
 * CLOUDFLARE_API_TOKEN. Exits 0 when every Worker matches, 1 on any
 * difference (a forbidden name a Worker holds included), 2 when the
 * arguments, the account or wrangler fail.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  accountIdFrom,
  formatDiffs,
  liveDiff,
  liveExpectations,
  parseTierArgument,
  parseWranglerSecretList,
  redactAccountIds,
  type NameDiff,
} from "../src/secrets/compare";
import type { Tier } from "../src/stage";

/** The repository's own Wrangler, the version the root package.json pins. */
const WRANGLER = fileURLToPath(new URL("../../../node_modules/.bin/wrangler", import.meta.url));

let tier: Tier;
let accountId: string;
try {
  tier = parseTierArgument(process.argv.slice(2));
  accountId = accountIdFrom(process.env);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const diffs: NameDiff[] = [];
for (const expected of liveExpectations(tier)) {
  const run = spawnSync(
    WRANGLER,
    ["secret", "list", "--name", expected.scriptName, "--format", "json"],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    },
  );
  if (run.status !== 0) {
    process.stderr.write(
      `wrangler secret list --name ${expected.scriptName} exited ${run.status}\n${redactAccountIds(run.stderr)}`,
    );
    process.exit(2);
  }
  try {
    diffs.push(liveDiff(expected, parseWranglerSecretList(run.stdout)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `wrangler secret list --name ${expected.scriptName} printed output this check cannot read: ${redactAccountIds(reason)}\n`,
    );
    process.exit(2);
  }
}
process.stdout.write(formatDiffs(diffs));
process.exit(
  diffs.every(
    (diff) =>
      diff.missing.length === 0 && diff.unexpected.length === 0 && diff.forbidden.length === 0,
  )
    ? 0
    : 1,
);
