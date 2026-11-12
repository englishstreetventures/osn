import { Data } from "effect";

import { knownCredentials } from "../accounts";
import type { Tier } from "../stage";

/**
 * Every secret each deployed Worker holds, per tier, and where the stacks take
 * it from (`source`):
 *
 *  - `environment` (dev): the GitHub Environment secret of the same name. The
 *    stack uploads every required name and every optional one that holds a
 *    value, so a secret a Worker should start holding is a change to this
 *    file, and one dropped from it is deleted by that Worker's next deploy.
 *  - `worker` (production): the Worker itself. The stacks upload no secret;
 *    each value is set on the Worker (`wrangler secret put`, or the
 *    set-osn-api-secret workflow), and every Alchemy upload keeps the secrets
 *    it does not name (the provider patch's `keep_bindings`). The release
 *    reads the live names before each deploy and refuses one that lacks a
 *    required name or holds a forbidden one.
 *
 * The production rows' required and present optional names equal `wrangler
 * secret list --name <scriptName>` on each live Worker. The dev rows name
 * what the dev account's Workers hold, which the dev stacks create with
 * these secrets. `bun run --cwd shared/infra secrets:check-live -- --tier
 * <tier>` compares either tier with what is live and reports any forbidden
 * name a Worker still holds.
 */
export type WorkerKey = "osn-api" | "cire-api" | "zap-api" | "cire-invites";

/**
 * Where a tier's Worker secrets come from: the GitHub Environment, which the
 * stack uploads on every deploy, or the Worker itself, which the stack never
 * uploads to and every upload keeps.
 */
export type SecretSource = "environment" | "worker";

export interface TierSecrets {
  /** The deployed script name, or null when the tier has no Worker. */
  readonly scriptName: string | null;
  readonly source: SecretSource;
  /**
   * Sorted names the Worker must hold. From the `environment`, each is
   * uploaded on every deploy and a missing value fails it; on the `worker`,
   * a deploy is refused while one is not live.
   */
  readonly secrets: readonly string[];
  /**
   * Sorted names the Worker may hold. From the `environment`, each is
   * uploaded only while its GitHub secret holds a value.
   */
  readonly optional: readonly string[];
  /** Names that must never be set on this Worker on this tier. */
  readonly forbidden: readonly string[];
  /**
   * Names this tier holds as plain-text vars although another tier holds them
   * as secrets: values that name no secret, such as a host derived from the
   * dev domain. `apiWorkerProps()` lets a var, and only a var, take one on
   * this tier.
   */
  readonly plainVars?: readonly string[];
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
        source: "environment",
        secrets: [
          "DEV_LOGIN_SECRET",
          "INTERNAL_SERVICE_SECRET",
          "OSN_JWT_PRIVATE_KEY",
          "OSN_JWT_PUBLIC_KEY",
          "OSN_PAIRWISE_SALT",
          "OSN_SESSION_IP_PEPPER",
          "OSN_TOTP_ENCRYPTION_KEY",
          "RESEND_API_KEY",
        ],
        // CIRE_INTERNAL_REVOKE_SECRET: the bearer for cire-api's organiser-session
        // revoke, held by both Workers (SHARED_SECRET_VALUES); unset, the revoke is
        // skipped. OSN_TOTP_ENCRYPTION_KEY_PREVIOUS: set only while a TOTP key
        // rotation drains (osn/api/wrangler.toml secrets block).
        optional: ["CIRE_INTERNAL_REVOKE_SECRET", "OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"],
        // RESEND_API_URL and OSN_EMAIL_VERIFICATION_EMULATOR_URL point osn-api at
        // local stand-ins; it refuses to boot with either outside a local stack.
        forbidden: ["OSN_EMAIL_VERIFICATION_EMULATOR_URL", "RESEND_API_URL"],
      },
      production: {
        scriptName: "osn-api-production",
        source: "worker",
        secrets: [
          "INTERNAL_SERVICE_SECRET",
          "OSN_JWT_PRIVATE_KEY",
          "OSN_JWT_PUBLIC_KEY",
          "OSN_PAIRWISE_SALT",
          "OSN_SESSION_IP_PEPPER",
          "OSN_TOTP_ENCRYPTION_KEY",
          "RESEND_API_KEY",
          "TURNSTILE_SECRET_KEY",
        ],
        optional: ["CIRE_INTERNAL_REVOKE_SECRET", "OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"],
        forbidden: ["DEV_LOGIN_SECRET", "OSN_EMAIL_VERIFICATION_EMULATOR_URL", "RESEND_API_URL"],
      },
    },
  },
  {
    worker: "cire-api",
    sourceDir: "cire/api/src",
    tiers: {
      dev: {
        scriptName: "cire-api-dev",
        source: "environment",
        secrets: [
          "CIRE_API_ARC_KEY_ID",
          "CIRE_API_ARC_PRIVATE_KEY",
          "CIRE_OIDC_CLIENT_SECRET",
          "STRIPE_PLATFORM_WEBHOOK_SECRET",
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
        ],
        // CIRE_INTERNAL_REVOKE_SECRET: what osn-api must present to end organiser
        // sessions; unset, that route answers 503.
        // CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS: weddings kept off the household
        // member step; unset, every household gets the step (cire/api/wrangler.toml,
        // top-level vars note).
        // STRIPE_CONNECT_CLIENT_ID: the platform's Stripe Connect OAuth client id
        // (`ca_…`); unset, no owner may connect a Stripe account they already
        // have. Not secret, but set with the other Stripe values.
        optional: [
          "CIRE_INTERNAL_REVOKE_SECRET",
          "CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS",
          "STRIPE_CONNECT_CLIENT_ID",
        ],
        // RESEND_API_URL, STRIPE_API_URL, STRIPE_CONNECT_URL: local stand-ins
        // only; the last two would send the platform's Stripe key elsewhere.
        forbidden: ["RESEND_API_URL", "STRIPE_API_URL", "STRIPE_CONNECT_URL"],
        // osn-api's dev origin, derived from the dev domain; a secret on production.
        plainVars: ["OSN_API_URL"],
      },
      production: {
        scriptName: "cire-api-production",
        source: "worker",
        secrets: [
          "CIRE_API_ARC_KEY_ID",
          "CIRE_API_ARC_PRIVATE_KEY",
          "CIRE_OIDC_CLIENT_SECRET",
          "GROWTHBOOK_CLIENT_KEY",
          "OSN_API_URL",
        ],
        // CIRE_OPS_EMAIL: the operator's address for the daily cron's claim
        // reminder and the R2 reconcilers' alerts; unset, the cron only logs.
        optional: [
          "CIRE_INTERNAL_REVOKE_SECRET",
          "CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS",
          "CIRE_OPS_EMAIL",
        ],
        forbidden: ["RESEND_API_URL", "STRIPE_API_URL", "STRIPE_CONNECT_URL"],
      },
    },
  },
  {
    worker: "zap-api",
    sourceDir: "zap/api/src",
    tiers: {
      dev: {
        scriptName: "zap-api-dev",
        source: "environment",
        secrets: ["INTERNAL_SERVICE_SECRET"],
        optional: [],
        // No zap code reads a GrowthBook key.
        forbidden: ["GROWTHBOOK_CLIENT_KEY"],
      },
      production: {
        scriptName: "zap-api-production",
        source: "worker",
        secrets: ["INTERNAL_SERVICE_SECRET"],
        optional: [],
        // No zap code reads a GrowthBook key; the release refuses zap-api
        // while it is live (englishstreetventures/osn#1532).
        forbidden: ["GROWTHBOOK_CLIENT_KEY"],
      },
    },
  },
  {
    worker: "cire-invites",
    sourceDir: "cire/invites/src",
    tiers: {
      dev: {
        scriptName: "cire-invites-dev",
        source: "environment",
        secrets: [],
        optional: [],
        forbidden: [],
      },
      production: {
        scriptName: "cire-invites",
        source: "worker",
        secrets: [],
        optional: [],
        forbidden: [],
      },
    },
  },
];

/**
 * A name two Workers hold on one tier must hold one value on both. On an
 * `environment` tier it is one GitHub secret, so the next deploy of each
 * stack gives both Workers its one value; on a `worker` tier each Worker
 * holds its own copy, set together. Each such pair is listed here on purpose.
 */
export const SHARED_SECRET_VALUES: readonly {
  readonly tier: Tier;
  readonly name: string;
  readonly workers: readonly WorkerKey[];
}[] = [
  // zap-api registers its ARC key at osn-api with this value, so both must hold the same one.
  { tier: "dev", name: "INTERNAL_SERVICE_SECRET", workers: ["osn-api", "zap-api"] },
  { tier: "production", name: "INTERNAL_SERVICE_SECRET", workers: ["osn-api", "zap-api"] },
  // osn-api presents this value to cire-api's organiser-session revoke, which
  // compares it with its own: one value on both, or every revoke is refused.
  { tier: "dev", name: "CIRE_INTERNAL_REVOKE_SECRET", workers: ["cire-api", "osn-api"] },
  { tier: "production", name: "CIRE_INTERNAL_REVOKE_SECRET", workers: ["cire-api", "osn-api"] },
];

/**
 * Secrets a tier's GitHub Environment holds for its workflows alone: no Worker
 * holds one, and none is a Cloudflare credential. `secrets:check-github`
 * requires each on its tier, since the job that reads it fails without it.
 * `tests/secrets/environments.test.ts` holds this list to what the jobs bound
 * to each Environment read.
 */
export const WORKFLOW_SECRETS = {
  dev: [
    // Fixes the key Astro writes into the guest site's build, read by the
    // cire stack job's build step (deploy.yml).
    "ASTRO_KEY",
    // The Cloudflare Access service token the smoke checks of the dev browser
    // hosts and the guest route comparison send (deploy.yml;
    // wiki/shared/dev-environment.md §5).
    "CF_ACCESS_CLIENT_ID",
    "CF_ACCESS_CLIENT_SECRET",
  ],
  // production-release.yml's jobs read the production account's pair, and
  // ENVIRONMENT_WORKER_SECRETS' production names.
  production: [],
} as const satisfies Readonly<Record<Tier, readonly string[]>>;

/**
 * Worker secret names a `worker`-sourced tier's GitHub Environment still
 * holds, because a workflow reads the value: no stack uploads them.
 * `secrets:check-github` requires each. On an `environment` tier every
 * required Worker secret is required there already.
 */
export const ENVIRONMENT_WORKER_SECRETS = {
  dev: [],
  // osn-api's production smoke check sends it to /health/coordination, which
  // answers only the value the Worker holds.
  production: ["INTERNAL_SERVICE_SECRET"],
} as const satisfies Readonly<Record<Tier, readonly string[]>>;

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
