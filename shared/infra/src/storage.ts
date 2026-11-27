import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Data } from "effect";

import { refuseUnadopted } from "./production";
import { PRODUCTION_ADOPTIONS } from "./production-sites";
import { physicalName, type StageNames, tierOf } from "./stage";

export class ProductionSeedError extends Data.TaggedError("ProductionSeedError")<{
  /** The database name. */
  readonly resource: string;
  readonly message: string;
}> {}

export class AdoptedLocationHintError extends Data.TaggedError("AdoptedLocationHintError")<{
  /** The database or bucket name. */
  readonly resource: string;
  readonly message: string;
}> {}

/** The table Alchemy keeps each database's migration ledger in. */
export const ALCHEMY_LEDGER = "__alchemy_migrations";

/** Production storage is adopted, so it never declares where it lives: a hint that differs from live replaces it. */
function refuseAdoptedHint(resource: string, stage: string, locationHint: string | null): void {
  if (locationHint !== null && tierOf(stage) === "production") {
    throw new AdoptedLocationHintError({
      resource,
      message: `${resource} is adopted on production and must not declare a location hint.`,
    });
  }
}

/**
 * A long-lived D1 database: on production adopted and declared exactly as
 * live, on dev created with production's settings. `clone` acts only at
 * creation and is never declared. `importFiles` are imported after the
 * migrations, and each is imported again whenever its content changes; a
 * file dropped from the list is forgotten, not undone (`@alchemy.run/cloudflare`
 * src/D1/Database.ts:313-319, 515-524).
 */
export interface RetainedD1Input {
  readonly name: string;
  readonly stage: string;
  readonly readReplication: "auto" | "disabled";
  readonly jurisdiction: NonNullable<Cloudflare.D1.DatabaseProps["jurisdiction"]>;
  /** Where a database this stage creates is placed; null on production, whose databases are adopted. */
  readonly locationHint: NonNullable<Cloudflare.D1.DatabaseProps["primaryLocationHint"]> | null;
  /**
   * The flattened directory Alchemy migrates this database from
   * (`flattenMigrations`): Alchemy is every database's one migrator, on every
   * stage, and keeps its ledger in `__alchemy_migrations`.
   */
  readonly migrations: string;
  /** SQL files Alchemy imports after the migrations, in order; refused on production, whose data is never seeded. */
  readonly importFiles: readonly string[];
}

/** The database's props. On production its name must be in `adoptions`, checked after the other production rules. */
export function retainedD1Props(
  input: RetainedD1Input,
  adoptions: readonly string[] = PRODUCTION_ADOPTIONS,
): Cloudflare.D1.DatabaseProps {
  refuseAdoptedHint(input.name, input.stage, input.locationHint);
  if (input.importFiles.length > 0 && tierOf(input.stage) === "production") {
    throw new ProductionSeedError({
      resource: input.name,
      message: `${input.name} is a production database, whose data is never seeded; declare no importFiles.`,
    });
  }
  refuseUnadopted(input.name, input.stage, adoptions);
  const declared: Cloudflare.D1.DatabaseProps = {
    name: input.name,
    readReplication: { mode: input.readReplication },
    jurisdiction: input.jurisdiction,
  };
  const placed =
    input.locationHint === null
      ? declared
      : { ...declared, primaryLocationHint: input.locationHint };
  // The table is named, not left to Alchemy: an explicit table beats one a
  // prior deploy stamped into state (`@alchemy.run/sql` Registry.ts
  // `resolveMigrations`), so a stamped `d1_migrations` can never become the
  // ledger Alchemy rebuilds in place. Wrangler's `d1_migrations` is converted
  // once, read only, and never written.
  const migrated = {
    ...placed,
    migrations: { dir: input.migrations, table: ALCHEMY_LEDGER },
  };
  return input.importFiles.length === 0
    ? migrated
    : { ...migrated, importFiles: [...input.importFiles] };
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

/** The bucket's props. On production its name must be in `adoptions`, checked after the other production rules. */
export function retainedBucketProps(
  input: RetainedBucketInput,
  adoptions: readonly string[] = PRODUCTION_ADOPTIONS,
): Cloudflare.R2.BucketProps {
  refuseAdoptedHint(input.name, input.stage, input.locationHint);
  refuseUnadopted(input.name, input.stage, adoptions);
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

/**
 * Days a deletion record is kept: D1 Time Travel restores a production
 * database to any minute of the last 30 days, and the records made after the
 * restore point are applied again after the restore, so each outlives that
 * window by a day.
 */
export const DELETION_RECORD_DAYS = 31;

/**
 * The lifecycle rules of every product's deletion-record bucket: the
 * multipart-abort rule Cloudflare gives a new bucket, kept so an adopted one
 * compares equal, and the rule that deletes each record
 * {@link DELETION_RECORD_DAYS} days after it is written.
 */
export const DELETION_RECORD_LIFECYCLE: NonNullable<Cloudflare.R2.BucketProps["lifecycleRules"]> = [
  {
    id: "Default Multipart Abort Rule",
    enabled: true,
    prefix: "",
    abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * 24 * 60 * 60 } },
  },
  {
    id: "Expire deletion records",
    enabled: true,
    prefix: "",
    deleteObjectsTransition: {
      condition: { type: "Age", maxAge: DELETION_RECORD_DAYS * 24 * 60 * 60 },
    },
  },
];

/**
 * A product's deletion-record bucket (`<product>-deletion-records`): where its
 * API Worker records each erasure request it accepts, outside the database a
 * restore can rewind (`@shared/db-utils/deletion-records`). Private, with no
 * CORS and no custom domain; bound to that Worker alone. Standard, default
 * jurisdiction; placed in ENAM on a stage that creates it, and declared with
 * no location hint on production, where it is adopted.
 */
export const deletionRecordsBucket = (base: string, stage: string): RetainedBucketInput => {
  const names: StageNames = { base, dev: `${base}-dev`, production: base };
  return {
    name: physicalName(names, stage),
    stage,
    storageClass: "Standard",
    jurisdiction: "default",
    locationHint: tierOf(stage) === "production" ? null : "enam",
    publicAccess: false,
    lifecycleRules: DELETION_RECORD_LIFECYCLE,
    cors: [],
    domains: [],
  };
};
