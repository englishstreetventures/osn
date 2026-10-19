#!/usr/bin/env bun
/**
 * Compares the secret inventory with the secret names each live Worker of one
 * tier holds: `CLOUDFLARE_ACCOUNT_ID=<id> bun run secrets:check-live -- --tier
 * <dev|production>`. Reads names only: `wrangler secret list` never returns a
 * value. CLOUDFLARE_ACCOUNT_ID names the account that serves the tier's
 * Workers and is required; credentials come from a `wrangler login` or
 * CLOUDFLARE_API_TOKEN. Exits 0 when every Worker matches, 1 on any
 * difference (a forbidden name a Worker holds included), 2 when the
 * arguments, the account or wrangler fail. The rules are in
 * `src/secrets/check.ts` (`checkLive`).
 */
import { fileURLToPath } from "node:url";

import { checkLive, type ToolRun } from "../src/secrets/check";
import { accountIdFrom, parseTierArgument } from "../src/secrets/compare";
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

async function listSecrets(scriptName: string): Promise<ToolRun> {
  try {
    const proc = Bun.spawn([WRANGLER, "secret", "list", "--name", scriptName, "--format", "json"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { status, stdout, stderr };
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      startError: error instanceof Error ? error.message : String(error),
    };
  }
}

const outcome = await checkLive(tier, listSecrets);
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exit(outcome.exitCode);
