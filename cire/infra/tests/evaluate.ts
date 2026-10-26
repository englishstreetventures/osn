import { tierSecrets } from "@shared/infra";
import * as Alchemy from "alchemy";

import {
  DEV_DOMAIN,
  evaluateStack,
  offlineStackOptions,
  stageSites,
  type Evaluation,
  type SiteFixtures,
} from "../../../shared/infra/tests/support/evaluate-stack";
import { cireStack } from "../alchemy.run";

export {
  DEV_DOMAIN,
  failureOf,
  removeEvaluations,
  resourcesOf,
  type EvaluatedResource,
  type Evaluation,
  type SiteFixtures,
} from "../../../shared/infra/tests/support/evaluate-stack";

/**
 * Everything the cire deploy step's environment holds, with placeholder
 * values: the deploy target, the dev domain and every secret the inventory
 * declares for cire-api and cire-invites on dev (required and optional).
 * STRIPE_SECRET_KEY is a test-mode key, as the dev tier requires.
 * `CIRE_DEV_OWNER_PROFILE_ID` is left unset; a test sets it.
 */
export function stackEnv(): Record<string, string | undefined> {
  const rows = [tierSecrets("cire-api", "dev"), tierSecrets("cire-invites", "dev")];
  return {
    DEV_DOMAIN,
    OSN_DEPLOY_TIER: "dev",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    CLOUDFLARE_API_TOKEN: "placeholder-token",
    ...Object.fromEntries(
      rows
        .flatMap((row) => row.secrets.concat(row.optional))
        .map((name) => [name, `placeholder-${name}`]),
    ),
    STRIPE_SECRET_KEY: "sk_test_placeholder",
  };
}

/** The prebuilt site directories the stack uploads, under `cire/`. */
export const SITE_DIRECTORIES: readonly string[] = [
  "invites/dist/client",
  "invites/dist/server",
  "host/dist",
  "vendor/dist",
  "landing/dist",
];

/** The guest site's server entry, which the stack stages before upload. */
export const INVITES_ENTRY_FIXTURE = "invites/dist/server/entry.mjs";

/**
 * Evaluates the cire stack body offline at `stage` with `env`. Site output
 * defaults to every origin of the stage's hosts in each of SITE_DIRECTORIES;
 * the guest site's server entry is always there, holding `entry` when given.
 */
export function evaluateCire(input: {
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sites?: SiteFixtures;
  readonly entry?: string;
  readonly workingDirFiles?: readonly string[];
}): Promise<Evaluation> {
  return evaluateStack({
    stage: input.stage,
    sites: input.sites ?? stageSites(SITE_DIRECTORIES, input.stage, input.env),
    files: { [INVITES_ENTRY_FIXTURE]: input.entry ?? "export default {};\n" },
    workingDirFiles: input.workingDirFiles,
    stack: ({ generatedDir, workingDir }) =>
      Alchemy.Stack(
        "cire",
        offlineStackOptions(),
        cireStack({ env: input.env, generatedDir, workingDir }),
      ),
  });
}
