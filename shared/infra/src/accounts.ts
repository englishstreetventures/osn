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
  // own, because the dev Environment's CLOUDFLARE_ACCOUNT_ID and
  // CLOUDFLARE_API_TOKEN_DEV reach the production account.
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
 * Credentials the `dev` Environment holds for the old dev tier's Wrangler
 * deploys. Both reach the production account; they are deleted with the old
 * dev tier.
 */
export const RETIRING_DEV_CREDENTIALS: readonly string[] = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN_DEV",
];

/** The `dev` Environment's read-only token for the dev account, which the free-tier ceiling alert reads. */
export const DEV_READONLY_CREDENTIALS: readonly string[] = [
  "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY",
];

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

/** Credential names `tier`'s Environment may hold besides its own account's, sorted. */
export function allowedCredentials(tier: Tier): readonly string[] {
  return tier === "dev"
    ? [...RETIRING_DEV_CREDENTIALS, ...DEV_READONLY_CREDENTIALS].toSorted()
    : [];
}

/** Credential names `tier`'s Environment must never hold: the other tier's, where this tier does not use the name too. */
export function forbiddenCredentials(tier: Tier): readonly string[] {
  const own = new Set([...accountSecrets(tier), ...allowedCredentials(tier)]);
  const other = otherTier(tier);
  return [...new Set([...accountSecrets(other), ...allowedCredentials(other)])]
    .filter((name) => !own.has(name))
    .toSorted();
}

/** Every Cloudflare credential name a workflow may read, sorted. */
export function knownCredentials(): readonly string[] {
  return [
    ...new Set([
      ...accountSecrets("dev"),
      ...accountSecrets("production"),
      ...RETIRING_DEV_CREDENTIALS,
      ...DEV_READONLY_CREDENTIALS,
      ...REPOSITORY_CREDENTIALS,
    ]),
  ].toSorted();
}
