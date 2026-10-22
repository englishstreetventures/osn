import * as Alchemy from "alchemy";

import {
  DEV_DOMAIN,
  evaluateStack,
  offlineStackOptions,
  stageSites,
  type Evaluation,
  type SiteFixtures,
} from "../../../shared/infra/tests/support/evaluate-stack";
import { pulseStack } from "../alchemy.run";

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
 * Everything the pulse deploy step's environment holds, with placeholder
 * values: the deploy target and the dev domain. Pulse landing holds no
 * secret.
 */
export function stackEnv(): Record<string, string | undefined> {
  return {
    DEV_DOMAIN,
    OSN_DEPLOY_TIER: "dev",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    CLOUDFLARE_API_TOKEN: "placeholder-token",
  };
}

/** The prebuilt site directory the stack uploads, under `pulse/`. */
export const SITE_DIRECTORIES: readonly string[] = ["landing/dist"];

/**
 * Evaluates the pulse stack body offline at `stage` with `env`. Site output
 * defaults to every origin of the stage's hosts in SITE_DIRECTORIES. The
 * stack writes no file.
 */
export function evaluatePulse(input: {
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sites?: SiteFixtures;
  readonly workingDirFiles?: readonly string[];
}): Promise<Evaluation> {
  return evaluateStack({
    stage: input.stage,
    sites: input.sites ?? stageSites(SITE_DIRECTORIES, input.stage, input.env),
    workingDirFiles: input.workingDirFiles,
    stack: ({ workingDir }) =>
      Alchemy.Stack("pulse", offlineStackOptions(), pulseStack({ env: input.env, workingDir })),
  });
}
