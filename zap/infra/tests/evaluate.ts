import { tierSecrets } from "@shared/infra";
import * as Alchemy from "alchemy";

import {
  DEV_DOMAIN,
  evaluateStack,
  offlineStackOptions,
  type Evaluation,
} from "../../../shared/infra/tests/support/evaluate-stack";
import { zapStack } from "../alchemy.run";

export {
  DEV_DOMAIN,
  failureOf,
  removeEvaluations,
  resourcesOf,
  type EvaluatedResource,
  type Evaluation,
} from "../../../shared/infra/tests/support/evaluate-stack";

/**
 * Everything the zap deploy step's environment holds, with placeholder
 * values: the deploy target, the dev domain and every secret the inventory
 * declares for zap-api on dev (required and optional).
 */
export function stackEnv(): Record<string, string | undefined> {
  const row = tierSecrets("zap-api", "dev");
  return {
    DEV_DOMAIN,
    OSN_DEPLOY_TIER: "dev",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    CLOUDFLARE_API_TOKEN: "placeholder-token",
    ...Object.fromEntries(
      [...row.secrets, ...row.optional].map((name) => [name, `placeholder-${name}`]),
    ),
  };
}

/** Evaluates the zap stack body offline at `stage` with `env`. The stack uploads no site. */
export function evaluateZap(input: {
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workingDirFiles?: readonly string[];
}): Promise<Evaluation> {
  return evaluateStack({
    stage: input.stage,
    sites: {},
    workingDirFiles: input.workingDirFiles,
    stack: ({ generatedDir, workingDir }) =>
      Alchemy.Stack(
        "zap",
        offlineStackOptions(),
        zapStack({ env: input.env, generatedDir, workingDir }),
      ),
  });
}
