import { Data } from "effect";

import { knownCredentials } from "../accounts";
import type { Tier } from "../stage";

/**
 * Every secret each deployed Worker holds, per tier. Alchemy uploads a Worker
 * with exactly the secrets its stack declares and drops the rest, so a name
 * missing here is a secret deleted by the first Alchemy deploy, and a secret
 * a Worker should start holding is a change to this file.
 *
 * The required and present optional names equal `wrangler secret list --name
 * <scriptName>` on each live Worker; `bun run --cwd shared/infra
 * secrets:check-live -- --tier <tier>` compares them and reports any
 * forbidden name a Worker still holds. Each value lives in the GitHub
 * Environment secret of the same name, in the `dev` or `production`
 * Environment.
 */
export type WorkerKey = "osn-api" | "cire-api" | "zap-api" | "cire-invites";

export interface TierSecrets {
  /** The deployed script name, or null when the tier has no Worker. */
  readonly scriptName: string | null;
  /** Sorted names declared on every deploy; a missing value fails it. */
  readonly secrets: readonly string[];
  /** Sorted names declared only while their GitHub secret holds a value. */
  readonly optional: readonly string[];
  /** Names that must never be set on this Worker on this tier. */
  readonly forbidden: readonly string[];
}

export interface WorkerSecrets {
  readonly worker: WorkerKey;
  /** The source directory whose code reads these secrets. */
  readonly sourceDir: string;
  readonly tiers: Readonly<Record<Tier, TierSecrets>>;
}

export const SECRET_INVENTORY: readonly WorkerSecrets[] = [
  {
    worker: "osn-api",
    sourceDir: "osn/api/src",
    tiers: {
      dev: {
        scriptName: "osn-api-dev",
        secrets: [
          "DEV_LOGIN_SECRET",
          "INTERNAL_SERVICE_SECRET",
          "OSN_JWT_PRIVATE_KEY",
          "OSN_JWT_PUBLIC_KEY",
          "OSN_PAIRWISE_SALT",
          "OSN_SESSION_IP_PEPPER",
          "OSN_TOTP_ENCRYPTION_KEY",
          "RESEND_API_KEY",
          "UPSTASH_REDIS_REST_TOKEN",
          "UPSTASH_REDIS_REST_URL",
        ],
        // Set only while a TOTP key rotation drains (osn/api/wrangler.toml secrets block).
        optional: ["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"],
        forbidden: ["RESEND_API_URL"],
      },
      production: {
        scriptName: "osn-api-production",
        secrets: [
          "INTERNAL_SERVICE_SECRET",
          "OSN_JWT_PRIVATE_KEY",
          "OSN_JWT_PUBLIC_KEY",
          "OSN_PAIRWISE_SALT",
          "OSN_SESSION_IP_PEPPER",
          "OSN_TOTP_ENCRYPTION_KEY",
          "RESEND_API_KEY",
          "TURNSTILE_SECRET_KEY",
          "UPSTASH_REDIS_REST_TOKEN",
          "UPSTASH_REDIS_REST_URL",
        ],
        optional: ["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"],
        forbidden: ["DEV_LOGIN_SECRET", "RESEND_API_URL"],
      },
    },
  },
  {
    worker: "cire-api",
    sourceDir: "cire/api/src",
    tiers: {
      dev: {
        scriptName: "cire-api-dev",
        secrets: [
          "CIRE_API_ARC_KEY_ID",
          "CIRE_API_ARC_PRIVATE_KEY",
          "CIRE_OIDC_CLIENT_SECRET",
          "OSN_API_URL",
          "STRIPE_PLATFORM_WEBHOOK_SECRET",
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
        ],
        // Weddings kept off the household member step; unset, every household
        // gets it (cire/api/wrangler.toml, top-level vars note).
        optional: ["CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS"],
        forbidden: ["RESEND_API_URL"],
      },
      production: {
        scriptName: "cire-api-production",
        secrets: [
          "CIRE_API_ARC_KEY_ID",
          "CIRE_API_ARC_PRIVATE_KEY",
          "CIRE_OIDC_CLIENT_SECRET",
          "GROWTHBOOK_CLIENT_KEY",
          "OSN_API_URL",
        ],
        optional: ["CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS"],
        forbidden: ["RESEND_API_URL"],
      },
    },
  },
  {
    worker: "zap-api",
    sourceDir: "zap/api/src",
    tiers: {
      dev: { scriptName: null, secrets: [], optional: [], forbidden: [] },
      production: {
        scriptName: "zap-api-production",
        secrets: ["INTERNAL_SERVICE_SECRET"],
        optional: [],
        // No zap code reads a GrowthBook key; zap-api's first Alchemy deploy
        // deletes the live one (englishstreetventures/osn#1532).
        forbidden: ["GROWTHBOOK_CLIENT_KEY"],
      },
    },
  },
  {
    worker: "cire-invites",
    sourceDir: "cire/invites/src",
    tiers: {
      dev: { scriptName: "cire-invites-dev", secrets: [], optional: [], forbidden: [] },
      production: { scriptName: "cire-invites", secrets: [], optional: [], forbidden: [] },
    },
  },
];

/**
 * A name two Workers hold on one tier is one GitHub secret, so the next
 * Alchemy deploy gives both Workers its one value. Each such pair is listed
 * here on purpose.
 */
export const SHARED_SECRET_VALUES: readonly {
  readonly tier: Tier;
  readonly name: string;
  readonly workers: readonly WorkerKey[];
}[] = [
  // zap-api registers its ARC key at osn-api with this value, so both must hold the same one.
  { tier: "production", name: "INTERNAL_SERVICE_SECRET", workers: ["osn-api", "zap-api"] },
];

/**
 * Names a deploy job already sets in its environment or reads as a
 * credential; no Worker secret may share one.
 */
export const DEPLOY_ENVIRONMENT: readonly string[] = [
  "CI",
  "DO_NOT_TRACK",
  ...knownCredentials(),
].toSorted();

export class NoWorkerOnTierError extends Data.TaggedError("NoWorkerOnTierError")<{
  readonly worker: WorkerKey;
  readonly tier: Tier;
  readonly message: string;
}> {}

/** The inventory row for one Worker on one tier; throws when that tier has no Worker. */
export function tierSecrets(
  worker: WorkerKey,
  tier: Tier,
): TierSecrets & { readonly scriptName: string } {
  const entry = SECRET_INVENTORY.find((candidate) => candidate.worker === worker);
  const row = entry?.tiers[tier];
  if (row === undefined || row.scriptName === null) {
    throw new NoWorkerOnTierError({
      worker,
      tier,
      message: `${worker} has no ${tier} Worker in the secret inventory; add one before declaring it.`,
    });
  }
  return { ...row, scriptName: row.scriptName };
}
