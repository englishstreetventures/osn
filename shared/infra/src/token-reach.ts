import { PRODUCTION_ZONES, readDevDomain } from "./hosts";
import type { CheckOutcome } from "./secrets/check";
import { redactAccountIds } from "./secrets/compare";
import type { Tier } from "./stage";

/** The HTTP status and body of `GET /client/v4/accounts`, or of one page of `GET /client/v4/zones`, called with a tier's token. */
export interface AccountListing {
  readonly status: number;
  readonly body: string;
}

const refused = (exitCode: 1 | 2, message: string): CheckOutcome => ({
  exitCode,
  stdout: "",
  stderr: `${redactAccountIds(message)}\n`,
});

/**
 * Dev and production are kept apart only by which account each tier's token
 * reaches, so a run goes ahead only when the token reaches exactly one
 * account and it is the one `accountId` names. Exits 1 when the token reaches
 * any other account, or none; 2 when the listing fails or cannot be read.
 * Prints no account id.
 */
export function checkTokenReach(accountId: string, listing: AccountListing): CheckOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listing.body);
  } catch {
    return refused(
      2,
      `GET /accounts returned HTTP ${listing.status} with a body that is not JSON.`,
    );
  }
  const response = parsed as {
    readonly success?: unknown;
    readonly errors?: readonly { readonly code?: unknown; readonly message?: unknown }[];
    readonly result?: unknown;
    readonly result_info?: { readonly total_count?: unknown };
  };
  if (listing.status !== 200 || response.success !== true || !Array.isArray(response.result)) {
    const errors = (response.errors ?? [])
      .map((error) => `${String(error.code)} ${String(error.message)}`)
      .join("; ");
    return refused(
      2,
      `GET /accounts returned HTTP ${listing.status}${errors === "" ? "" : `: ${errors}`}. The token must be able to list the accounts it reaches.`,
    );
  }
  const ids = (response.result as readonly { readonly id?: unknown }[]).map(
    (account) => account.id,
  );
  const total =
    typeof response.result_info?.total_count === "number"
      ? response.result_info.total_count
      : ids.length;
  if (total !== 1 || ids.length !== 1) {
    return refused(
      1,
      `This token reaches ${total} accounts. A tier's token must reach exactly one: its own.`,
    );
  }
  if (ids[0] !== accountId) {
    return refused(
      1,
      "This token reaches one account, but not the one CLOUDFLARE_ACCOUNT_ID names.",
    );
  }
  return {
    exitCode: 0,
    stdout: "The token reaches exactly the account CLOUDFLARE_ACCOUNT_ID names.\n",
    stderr: "",
  };
}

/** What `token:check` checks: the tier it runs for, and on dev the dev domain. */
export interface TokenCheckScope {
  readonly tier: Tier;
  readonly devDomain: string | null;
}

/**
 * Reads `--tier dev|production` from the arguments and, on dev, `DEV_DOMAIN`
 * from `env`. Throws on a missing or unknown tier, and on a dev domain that
 * is unset or that `parseDevDomain()` refuses.
 */
export function tokenCheckScope(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): TokenCheckScope {
  const at = argv.indexOf("--tier");
  const tier = at === -1 ? undefined : argv[at + 1];
  if (tier === "production") return { tier, devDomain: null };
  if (tier === "dev") return { tier, devDomain: readDevDomain(env) };
  throw new Error("pass --tier dev or --tier production");
}

const underProduction = (name: string): string | undefined =>
  PRODUCTION_ZONES.find((zone) => name === zone || name.endsWith(`.${zone}`));

/**
 * A token scopes zones apart from accounts, so a grant on another account's
 * zone need not show in `GET /accounts`. This reads every page of
 * `GET /zones` a dev token can act on: each zone must belong to the account
 * `accountId` names, none may be a production zone or under one, and the dev
 * domain's own zone must be listed, which also refuses an account id that
 * names production. `token:check` runs it on dev only. Exits 1 on any of those; 2
 * when a page fails or cannot be read, or the pages hold fewer zones than the
 * first one's `total_count`.
 * Prints no account id.
 */
export function checkZoneReach(
  accountId: string,
  devDomain: string,
  pages: readonly AccountListing[],
): CheckOutcome {
  const zones: { readonly name: string; readonly account: unknown }[] = [];
  let totalCount = 0;
  for (const [index, page] of pages.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(page.body);
    } catch {
      return refused(2, `GET /zones returned HTTP ${page.status} with a body that is not JSON.`);
    }
    const response = parsed as {
      readonly success?: unknown;
      readonly result?: unknown;
      readonly result_info?: { readonly total_count?: unknown };
    };
    if (page.status !== 200 || response.success !== true || !Array.isArray(response.result)) {
      return refused(
        2,
        `GET /zones returned HTTP ${page.status}. The token must be able to list the zones it reaches.`,
      );
    }
    if (index === 0) {
      totalCount = Number(response.result_info?.total_count ?? response.result.length);
    }
    for (const zone of response.result as readonly {
      name?: unknown;
      account?: { id?: unknown };
    }[]) {
      zones.push({ name: String(zone.name), account: zone.account?.id });
    }
  }
  if (pages.length === 0 || zones.length !== totalCount) {
    return refused(2, "GET /zones did not return every page of the token's zones.");
  }
  const foreign = zones.filter((zone) => zone.account !== accountId).map((zone) => zone.name);
  if (foreign.length > 0) {
    return refused(
      1,
      `This token can act on zones outside the account CLOUDFLARE_ACCOUNT_ID names: ${foreign.join(", ")}.`,
    );
  }
  const production = zones.map((zone) => zone.name).filter((name) => underProduction(name));
  if (production.length > 0) {
    return refused(
      1,
      `A dev token can act on production zones: ${production.join(", ")}. A dev token acts on no production zone.`,
    );
  }
  if (!zones.some((zone) => zone.name === devDomain)) {
    return refused(
      1,
      `This token cannot act on the zone ${devDomain} that DEV_DOMAIN names: the token lacks Zone Read on it, or CLOUDFLARE_ACCOUNT_ID does not name the dev account.`,
    );
  }
  return {
    exitCode: 0,
    stdout: "Every zone the token can act on belongs to that account.\n",
    stderr: "",
  };
}
