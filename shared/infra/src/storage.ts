import type * as Cloudflare from "alchemy/Cloudflare";
import { Data } from "effect";

import { tierOf } from "./stage";

export class AdoptedLocationHintError extends Data.TaggedError("AdoptedLocationHintError")<{
  readonly name: string;
  readonly message: string;
}> {}

/** Production storage is adopted, so it never declares where it lives: a hint that differs from live replaces it. */
function refuseAdoptedHint(name: string, stage: string, locationHint: string | null): void {
  if (locationHint !== null && tierOf(stage) === "production") {
    throw new AdoptedLocationHintError({
      name,
      message: `${name} is adopted on production and must not declare a location hint.`,
    });
  }
}

/**
 * A long-lived D1 database: on production adopted and declared exactly as
 * live, on dev created with production's settings. `clone` and
 * `importFiles` act only at creation and are never declared.
 */
export interface RetainedD1Input {
  readonly name: string;
  readonly stage: string;
  readonly readReplication: "auto" | "disabled";
  readonly jurisdiction: NonNullable<Cloudflare.D1.DatabaseProps["jurisdiction"]>;
  /** Where a database this stage creates is placed; null on production, whose databases are adopted. */
  readonly locationHint: NonNullable<Cloudflare.D1.DatabaseProps["primaryLocationHint"]> | null;
  /** The migrations directory once Alchemy migrates this database; null while Wrangler still does. */
  readonly migrations: string | null;
}

export function retainedD1Props(input: RetainedD1Input): Cloudflare.D1.DatabaseProps {
  refuseAdoptedHint(input.name, input.stage, input.locationHint);
  const declared: Cloudflare.D1.DatabaseProps = {
    name: input.name,
    readReplication: { mode: input.readReplication },
    jurisdiction: input.jurisdiction,
  };
  const placed =
    input.locationHint === null
      ? declared
      : { ...declared, primaryLocationHint: input.locationHint };
  return input.migrations === null ? placed : { ...placed, migrations: input.migrations };
}

/**
 * A long-lived R2 bucket: on production adopted and declared exactly as
 * live, on dev created with production's settings. Alchemy clears lifecycle
 * rules, CORS and custom domains a declaration omits, so each is required;
 * object locks stay unmanaged.
 */
export interface RetainedBucketInput {
  readonly name: string;
  readonly stage: string;
  readonly storageClass: NonNullable<Cloudflare.R2.BucketProps["storageClass"]>;
  readonly jurisdiction: NonNullable<Cloudflare.R2.BucketProps["jurisdiction"]>;
  /** Where a bucket this stage creates is placed; null on production, whose buckets are adopted. */
  readonly locationHint: NonNullable<Cloudflare.R2.BucketProps["locationHint"]> | null;
  readonly publicAccess: boolean;
  readonly lifecycleRules: NonNullable<Cloudflare.R2.BucketProps["lifecycleRules"]>;
  readonly cors: NonNullable<Cloudflare.R2.BucketProps["cors"]>;
  readonly domains: NonNullable<Cloudflare.R2.BucketProps["domains"]>;
}

export function retainedBucketProps(input: RetainedBucketInput): Cloudflare.R2.BucketProps {
  refuseAdoptedHint(input.name, input.stage, input.locationHint);
  const declared: Cloudflare.R2.BucketProps = {
    name: input.name,
    storageClass: input.storageClass,
    jurisdiction: input.jurisdiction,
    publicAccess: input.publicAccess,
    lifecycleRules: [...input.lifecycleRules],
    cors: [...input.cors],
    domains: [...input.domains],
    forceDestroy: false,
  };
  return input.locationHint === null ? declared : { ...declared, locationHint: input.locationHint };
}
