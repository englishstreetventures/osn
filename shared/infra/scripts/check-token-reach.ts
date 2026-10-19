#!/usr/bin/env bun
/**
 * Fails unless CLOUDFLARE_API_TOKEN reaches exactly one Cloudflare account,
 * the one CLOUDFLARE_ACCOUNT_ID names: `bun run token:check -- --tier
 * <dev|production>`. On dev it also reads every zone the token can act on and
 * refuses a zone of another account, a production zone, and a token that
 * cannot act on the zone DEV_DOMAIN names. Every Alchemy run in CI calls it first,
 * because dev and production are kept apart only by what each tier's token
 * reaches. Exits 0 when it holds, 1 when the token reaches another account or
 * zone, or none, 2 when an argument or variable is missing or a listing fails.
 * Prints no account id and never the token. The rules are `checkTokenReach()`
 * and `checkZoneReach()` in `src/token-reach.ts`.
 */
import { accountIdFrom } from "../src/secrets/compare";
import {
  checkTokenReach,
  checkZoneReach,
  tokenCheckScope,
  type AccountListing,
  type TokenCheckScope,
} from "../src/token-reach";

let accountId: string;
let scope: TokenCheckScope;
const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
try {
  scope = tokenCheckScope(process.argv.slice(2), process.env);
  accountId = accountIdFrom(process.env);
  if (token === "") throw new Error("set CLOUDFLARE_API_TOKEN to the tier's token");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

/** One GET with the token; exits 2 when the request does not complete. */
async function read(path: string): Promise<AccountListing> {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    process.stderr.write(
      `GET ${path.split("?")[0]} did not complete: ${error instanceof Error ? error.name : "unknown error"}\n`,
    );
    process.exit(2);
  }
}

const accounts = checkTokenReach(accountId, await read("/accounts?per_page=50"));
process.stdout.write(accounts.stdout);
process.stderr.write(accounts.stderr);
if (accounts.exitCode !== 0 || scope.devDomain === null) process.exit(accounts.exitCode);

// Cloudflare caps a zones page at 50; read pages until the first one's
// total_pages, at most 20 (1,000 zones), which no tier's token comes near.
const pages: AccountListing[] = [await read("/zones?per_page=50&page=1")];
const totalPages = (() => {
  try {
    const first = JSON.parse(pages[0]?.body ?? "") as { result_info?: { total_pages?: unknown } };
    return Math.min(20, Number(first.result_info?.total_pages ?? 1));
  } catch {
    return 1;
  }
})();
pages.push(
  ...(await Promise.all(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) =>
      read(`/zones?per_page=50&page=${index + 2}`),
    ),
  )),
);
const zones = checkZoneReach(accountId, scope.devDomain, pages);
process.stdout.write(zones.stdout);
process.stderr.write(zones.stderr);
process.exit(zones.exitCode);
