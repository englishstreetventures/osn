import { existsSync } from "node:fs";
import { join } from "node:path";

import { Data } from "effect";

import { parseStage, tierOf } from "./stage";

export class StageNotDeclaredError extends Data.TaggedError("StageNotDeclaredError")<{
  readonly stage: string;
  readonly message: string;
}> {}

export class DeployTargetError extends Data.TaggedError("DeployTargetError")<{
  readonly stage: string;
  readonly message: string;
}> {}

/** Throws for a stage on the production tier, which no stack declares yet. */
export function refuseProductionTier(stage: string): void {
  if (tierOf(stage) === "production") {
    throw new StageNotDeclaredError({
      stage,
      message: `Stage '${stage}' is the production tier, which these stacks declare from phase P3 of englishstreetventures/osn#1490.`,
    });
  }
}

const CREDENTIALS: readonly string[] = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"];

/**
 * The stage a stack may run at, refusing a run whose credentials could reach
 * another account: `OSN_DEPLOY_TIER` must name the stage's tier, and both
 * Cloudflare credentials must be set. Messages name variables, never values.
 */
export function assertDevDeployTarget(
  stage: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const valid = parseStage(stage);
  refuseProductionTier(valid);
  const tier = tierOf(valid);
  if (env.OSN_DEPLOY_TIER !== tier) {
    throw new DeployTargetError({
      stage: valid,
      message: `Stage '${valid}' runs on the ${tier} tier, and OSN_DEPLOY_TIER does not say ${tier}. Set OSN_DEPLOY_TIER beside the ${tier} account's credentials.`,
    });
  }
  // Alchemy reads the account from the environment only when both are set
  // (alchemy src/Auth/Resolve.ts:51-90); otherwise it loads a stored profile.
  for (const name of CREDENTIALS) {
    if ((env[name] ?? "").trim() === "") {
      throw new DeployTargetError({
        stage: valid,
        message: `${name} is unset or blank, so Alchemy would choose the account from a stored profile. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to the ${tier} account's credentials.`,
      });
    }
  }
  return valid;
}

/**
 * Every `.env` file Bun loads from the working directory into process.env,
 * whatever NODE_ENV is; a stack directory must hold none. Which ones load
 * depends on how the CLI starts: `bunx --bun alchemy` runs it in a Bun
 * started with the shell's NODE_ENV (unset: `.env`, `.env.local` and the
 * `.development` pair), while `bun alchemy` starts it under Node, which sets
 * NODE_ENV to production (`alchemy/bin/cli.js:17`) and hands off to a Bun
 * that loads `.env`, `.env.local` and the `.production` pair. NODE_ENV=test
 * loads `.env` and the `.test` pair.
 */
export const DOT_ENV_FILES: readonly string[] = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];

/** Throws when `directory` holds a file Bun would load into the stack's environment, naming it. */
export function refuseDotEnvFiles(directory: string): void {
  const found = DOT_ENV_FILES.find((name) => existsSync(join(directory, name)));
  if (found !== undefined) {
    throw new DeployTargetError({
      stage: "",
      message: `${found} in ${directory} would be loaded into the stack's environment by Bun; remove it.`,
    });
  }
}
