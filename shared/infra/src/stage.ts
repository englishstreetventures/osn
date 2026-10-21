import { Data } from "effect";

/** A tier is one Cloudflare account, with its own credentials and state store. */
export type Tier = "dev" | "production";

/**
 * Stage names a stack refuses besides malformed ones. `prod`: the production
 * D1 databases are `osn-db-prod` and `zap-db-prod`, so a stage `prod` derives
 * a live production name. `staging`: `osn-db-staging` exists and
 * `osn/api/wrangler.toml` declares `[env.staging]`. `local`: the `OSN_ENV`
 * posture of `wrangler dev` (`osn/api/wrangler.toml` `[vars]`).
 */
export const RESERVED_STAGES: readonly string[] = ["prod", "staging", "local"];

export const MAX_STAGE_LENGTH = 20;

/** Cloudflare's limit on Worker script and R2 bucket names. */
export const MAX_RESOURCE_NAME_LENGTH = 63;

const STAGE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class InvalidStageError extends Data.TaggedError("InvalidStageError")<{
  readonly stage: string;
  readonly message: string;
}> {}

const invalid = (stage: string, reason: string): InvalidStageError =>
  new InvalidStageError({ stage, message: `Stage '${stage}' is not allowed: ${reason}.` });

/** Returns `stage` when a stack may run at it, and throws InvalidStageError otherwise. */
export function parseStage(stage: string): string {
  if (stage.length === 0 || stage.length > MAX_STAGE_LENGTH) {
    throw invalid(stage, `a stage is 1 to ${MAX_STAGE_LENGTH} characters`);
  }
  if (!STAGE_PATTERN.test(stage)) {
    throw invalid(
      stage,
      "use lowercase letters and digits in groups joined by single hyphens, starting with a letter",
    );
  }
  if (RESERVED_STAGES.includes(stage)) {
    throw invalid(
      stage,
      "the name is reserved because it derives or imitates a live resource name",
    );
  }
  return stage;
}

/** `dev` and `production` are long-lived and keep today's names; any other stage is an investigation stage. */
export function isLongLivedStage(stage: string): boolean {
  const valid = parseStage(stage);
  return valid === "dev" || valid === "production";
}

/** Only the stage named exactly `production` reaches production credentials. */
export function tierOf(stage: string): Tier {
  return parseStage(stage) === "production" ? "production" : "dev";
}

/** A resource's name on dev and on production, and the base an investigation stage extends. */
export interface StageNames {
  readonly base: string;
  readonly dev: string;
  readonly production: string;
}

/** The physical name a resource takes at `stage`. */
export function physicalName(names: StageNames, stage: string): string {
  const valid = parseStage(stage);
  if (valid === "dev") return names.dev;
  if (valid === "production") return names.production;
  const derived = `${names.base}-${valid}`;
  if (derived === names.dev || derived === names.production) {
    throw invalid(stage, `it derives '${derived}', a dev or production name`);
  }
  if (derived.length > MAX_RESOURCE_NAME_LENGTH) {
    throw invalid(
      stage,
      `it derives '${derived}', longer than ${MAX_RESOURCE_NAME_LENGTH} characters`,
    );
  }
  return derived;
}
