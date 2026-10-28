/**
 * The deploy targets every stack must refuse before it writes or declares
 * anything, as one table each stack's K12 test runs through its own
 * evaluation: the stage-to-account guard, the dev-domain check and the
 * secret check are each called from the stack body, and only an evaluation
 * shows that the body calls them.
 */

import { expect } from "vitest";

import type { InvalidDevDomainError } from "../../src/hosts";
import { tierSecrets, type WorkerKey } from "../../src/secrets/inventory";
import type { MissingSecretsError } from "../../src/secrets/require";
import type { DeployTargetError, StageNotDeclaredError } from "../../src/target";
import type { Evaluation } from "./evaluate-stack";

type Env = Readonly<Record<string, string | undefined>>;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface RefusedTarget {
  /** What is wrong with the run. */
  readonly name: string;
  readonly stage: string;
  /** The deploy step's environment, made wrong. */
  readonly edit: (env: Env) => Env;
  /** Files placed in the stack's working directory before it runs. */
  readonly workingDirFiles: readonly string[];
  /**
   * The refusal's `_tag`. A stack test matches the tag, not the class: a
   * stack reaches these errors through `@shared/infra` and this file through
   * relative paths, which Stryker's sandbox resolves to two copies.
   */
  readonly refusal: (
    | DeployTargetError
    | InvalidDevDomainError
    | MissingSecretsError
    | StageNotDeclaredError
  )["_tag"];
  /** Fields the refusal must carry, given the evaluation it ended. */
  readonly fields: (evaluation: Evaluation) => Readonly<Record<string, unknown>>;
}

const target = (
  name: string,
  refusal: RefusedTarget["refusal"],
  edit: RefusedTarget["edit"],
  fields: RefusedTarget["fields"] = () => ({}),
  options: { readonly stage?: string; readonly workingDirFiles?: readonly string[] } = {},
): RefusedTarget => ({
  name,
  stage: options.stage ?? "dev",
  edit,
  workingDirFiles: options.workingDirFiles ?? [],
  refusal,
  fields,
});

/**
 * The production-stage cases. A stack that declares production refuses a run
 * whose target is wrong; one that does not refuses the stage itself, even
 * with the production tier's target set.
 */
function productionTargets(production: "declared" | "refused"): readonly RefusedTarget[] {
  const onProduction = { stage: "production" } as const;
  if (production === "refused") {
    return [
      target(
        "the production stage, which this stack does not declare",
        "StageNotDeclaredError",
        (env) => ({ ...env, OSN_DEPLOY_TIER: "production" }),
        () => ({ stage: "production" }),
        onProduction,
      ),
    ];
  }
  return [
    target(
      "the production stage with OSN_DEPLOY_TIER naming dev",
      "DeployTargetError",
      (env) => ({ ...env, OSN_DEPLOY_TIER: "dev" }),
      () => ({ message: expect.stringMatching(/OSN_DEPLOY_TIER does not say production/) }),
      onProduction,
    ),
    target(
      "the production stage with CLOUDFLARE_API_TOKEN blank",
      "DeployTargetError",
      (env) => ({ ...env, OSN_DEPLOY_TIER: "production", CLOUDFLARE_API_TOKEN: "" }),
      () => ({ message: expect.stringMatching(/^CLOUDFLARE_API_TOKEN is unset or blank/) }),
      onProduction,
    ),
    target(
      "a .env file in the stack's working directory on the production stage",
      "DeployTargetError",
      (env) => ({ ...env, OSN_DEPLOY_TIER: "production" }),
      (evaluation) => ({
        message: expect.stringMatching(
          new RegExp(`^\\.env in ${escapeRegExp(evaluation.workingDir)} `),
        ),
      }),
      { ...onProduction, workingDirFiles: [".env"] },
    ),
  ];
}

/**
 * Each refused deploy target, for a stack whose API Workers are `workers`
 * (one case per Worker that requires a secret on dev, with every required
 * secret blank), and whose production stage is `production`: declared (its
 * production sites) or refused.
 */
export function refusedTargets(
  workers: readonly WorkerKey[],
  production: "declared" | "refused",
): readonly RefusedTarget[] {
  return [
    target("OSN_DEPLOY_TIER unset", "DeployTargetError", (env) => ({
      ...env,
      OSN_DEPLOY_TIER: undefined,
    })),
    target("OSN_DEPLOY_TIER naming production", "DeployTargetError", (env) => ({
      ...env,
      OSN_DEPLOY_TIER: "production",
    })),
    target(
      "CLOUDFLARE_API_TOKEN blank",
      "DeployTargetError",
      (env) => ({ ...env, CLOUDFLARE_API_TOKEN: " " }),
      () => ({ message: expect.stringMatching(/^CLOUDFLARE_API_TOKEN is unset or blank/) }),
    ),
    target(
      "CLOUDFLARE_ACCOUNT_ID empty",
      "DeployTargetError",
      (env) => ({ ...env, CLOUDFLARE_ACCOUNT_ID: "" }),
      () => ({ message: expect.stringMatching(/^CLOUDFLARE_ACCOUNT_ID is unset or blank/) }),
    ),
    target(
      "DEV_DOMAIN a production zone",
      "InvalidDevDomainError",
      (env) => ({ ...env, DEV_DOMAIN: "musubi.social" }),
      () => ({ domain: "musubi.social" }),
    ),
    ...productionTargets(production),
    target(
      "a .env file in the stack's working directory",
      "DeployTargetError",
      (env) => env,
      (evaluation) => ({
        message: expect.stringMatching(
          new RegExp(`^\\.env in ${escapeRegExp(evaluation.workingDir)} `),
        ),
      }),
      { workingDirFiles: [".env"] },
    ),
    ...workers
      .map((worker) => ({ worker, required: tierSecrets(worker, "dev").secrets }))
      .filter(({ required }) => required.length > 0)
      .map(({ worker, required }) =>
        target(
          `every secret ${worker} requires on dev blank`,
          "MissingSecretsError",
          (env) => ({ ...env, ...Object.fromEntries(required.map((name) => [name, ""])) }),
          () => ({ worker, missing: required }),
        ),
      ),
  ];
}
