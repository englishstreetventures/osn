import type { Tier } from "./stage";

/**
 * Where one tier's Alchemy jobs find their Cloudflare account. Each tier is
 * its own account with its own state store, chosen only by the credentials a
 * job carries: the job maps `accountIdSecret` to `CLOUDFLARE_ACCOUNT_ID` and
 * `apiTokenSecret` to `CLOUDFLARE_API_TOKEN`, the two variables Alchemy reads.
 * No file holds an account id.
 */
export interface TierAccount {
  /** The GitHub Environment holding both secrets. */
  readonly environment: Tier;
  readonly accountIdSecret: string;
  readonly apiTokenSecret: string;
}

export const TIER_ACCOUNTS = {
  // A separate account from production. Its credentials take names of their
  // own: production's account-id name, read in the dev Environment, falls
  // back to the repository's CLOUDFLARE_ACCOUNT_ID, the production account.
  dev: {
    environment: "dev",
    accountIdSecret: "CLOUDFLARE_DEV_ACCOUNT_ID",
    apiTokenSecret: "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN",
  },
  // The account production has always run in, under the names the
  // production release jobs read.
  production: {
    environment: "production",
    accountIdSecret: "CLOUDFLARE_ACCOUNT_ID",
    apiTokenSecret: "CLOUDFLARE_API_TOKEN",
  },
} as const satisfies Readonly<Record<Tier, TierAccount>>;

/**
 * Credential names the `dev` Environment must never hold: the production
 * account's id, and the name a Wrangler token on that account goes by. `dev`
 * has no reviewer, so either there gives every workflow on `main` a path to
 * production. Forbidden on every tier whose own account does not use the name.
 */
export const RETIRED_DEV_CREDENTIALS: readonly string[] = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN_DEV",
];

/**
 * The `dev` Environment's read-only token for the dev account. The free-tier
 * ceiling alert's dev job reads it and fails without it, so the dev
 * Environment must hold it.
 */
export const DEV_READONLY_CREDENTIALS: readonly string[] = [
  "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY",
];

/**
 * The `production` Environment's token for moving a site's custom domain
 * between its Pages project and its Worker: Pages Edit on the account and
 * DNS Edit on cireweddings.com and musubi.social, nothing else, and able to
 * list its account. scripts/pages-domain.ts refuses it unless it reaches
 * exactly that account and those zones. Only that script reads it, in a step
 * that runs before any install or in a job that installs nothing, so no
 * dependency's code ever holds it.
 */
export const PAGES_DNS_CREDENTIALS: readonly string[] = ["CLOUDFLARE_PAGES_DNS_TOKEN"];

/** Repository-level credentials, outside both Environments: read-only access to the production account. */
export const REPOSITORY_CREDENTIALS: readonly string[] = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN_READONLY",
];

const otherTier = (tier: Tier): Tier => (tier === "dev" ? "production" : "dev");

/** The two GitHub Environment secrets that give `tier`'s jobs its account, sorted. */
export function accountSecrets(tier: Tier): readonly string[] {
  const account = TIER_ACCOUNTS[tier];
  return [account.accountIdSecret, account.apiTokenSecret].toSorted();
}

/**
 * The credentials `tier`'s Environment must hold: its account's pair, and on
 * dev the read-only token, on production the Pages and DNS token. Sorted.
 */
export function requiredCredentials(tier: Tier): readonly string[] {
  return [
    ...accountSecrets(tier),
    ...(tier === "dev" ? DEV_READONLY_CREDENTIALS : PAGES_DNS_CREDENTIALS),
  ].toSorted();
}

/** Credential names `tier`'s Environment must never hold: the other tier's and the retired dev ones, where this tier does not use the name too. Sorted. */
export function forbiddenCredentials(tier: Tier): readonly string[] {
  const own = new Set(requiredCredentials(tier));
  return [...new Set([...requiredCredentials(otherTier(tier)), ...RETIRED_DEV_CREDENTIALS])]
    .filter((name) => !own.has(name))
    .toSorted();
}

/** Every Cloudflare credential name a workflow may read, sorted. */
export function knownCredentials(): readonly string[] {
  return [
    ...new Set([
      ...accountSecrets("dev"),
      ...accountSecrets("production"),
      ...DEV_READONLY_CREDENTIALS,
      ...PAGES_DNS_CREDENTIALS,
      ...REPOSITORY_CREDENTIALS,
    ]),
  ].toSorted();
}
