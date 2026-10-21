#!/usr/bin/env bun
/**
 * Fails unless CLOUDFLARE_API_TOKEN reaches exactly one Cloudflare account,
 * the one CLOUDFLARE_ACCOUNT_ID names: `bun run token:check`. Every Alchemy
 * run in CI calls it first, because dev and production are kept apart only by
 * which account each tier's token reaches. Exits 0 when it does, 1 when the
 * token reaches another account or none, 2 when a variable is unset or the
 * listing fails. Prints no account id and never the token. The rules are
 * `checkTokenReach()` in `src/token-reach.ts`.
 */
import { accountIdFrom } from "../src/secrets/compare";
import { checkTokenReach, type AccountListing } from "../src/token-reach";

let accountId: string;
const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
try {
  accountId = accountIdFrom(process.env);
  if (token === "") throw new Error("set CLOUDFLARE_API_TOKEN to the tier's token");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

let listing: AccountListing;
try {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=50", {
    headers: { Authorization: `Bearer ${token}` },
  });
  listing = { status: response.status, body: await response.text() };
} catch (error) {
  process.stderr.write(
    `GET /accounts did not complete: ${error instanceof Error ? error.name : "unknown error"}\n`,
  );
  process.exit(2);
}

const outcome = checkTokenReach(accountId, listing);
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exit(outcome.exitCode);
