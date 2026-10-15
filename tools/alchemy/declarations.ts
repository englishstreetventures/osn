/**
 * Every storage resource the probe adopts, with the settings it declares for
 * it. `alchemy.run.ts` builds each Alchemy resource from its entry here, and
 * `storage-preflight.ts` checks the live resource against the same entry, so
 * what the preflight checks is what Alchemy's adoption update would write.
 *
 * A setting every dev bucket (or database) has belongs in
 * `DEV_BUCKET_SETTINGS` (or `DEV_DATABASE_SETTINGS`); a setting only one
 * resource has belongs in that resource's own `settings` below.
 */
import { PROBE } from "./boundary.ts";
import {
  DEV_BUCKET_SETTINGS,
  DEV_DATABASE_SETTINGS,
  type BucketSettings,
  type DatabaseSettings,
  type DeclaredStorage,
} from "./storage-preflight.ts";

export type BucketDeclaration = {
  /** Alchemy's logical id; it keys the state row, so it never changes. */
  readonly logicalId: string;
  readonly binding: string;
  readonly name: string;
  readonly settings: BucketSettings;
};

export type DatabaseDeclaration = {
  readonly logicalId: string;
  readonly name: string;
  readonly id: string;
  readonly settings: DatabaseSettings;
};

const [sheets, assets] = PROBE.cire.buckets;

export const CIRE_BUCKETS: readonly BucketDeclaration[] = [
  { logicalId: "CireDevSheets", ...sheets, settings: DEV_BUCKET_SETTINGS },
  { logicalId: "CireDevAssets", ...assets, settings: DEV_BUCKET_SETTINGS },
];

export const CIRE_DATABASE: DatabaseDeclaration = {
  logicalId: "CireDevDb",
  name: PROBE.cire.database.name,
  id: PROBE.cire.database.id,
  settings: DEV_DATABASE_SETTINGS,
};

export const OSN_DATABASE: DatabaseDeclaration = {
  logicalId: "OsnDevDb",
  name: PROBE.osn.database.name,
  id: PROBE.osn.database.id,
  settings: DEV_DATABASE_SETTINGS,
};

/** The same entries, keyed by name, in the shape `checkAdoptedStorage` reads. */
export const declaredStorage: DeclaredStorage = {
  buckets: Object.fromEntries(CIRE_BUCKETS.map((bucket) => [bucket.name, bucket.settings])),
  databases: Object.fromEntries(
    [CIRE_DATABASE, OSN_DATABASE].map((database) => [
      database.name,
      { id: database.id, ...database.settings },
    ]),
  ),
};

/**
 * Every adopted resource must survive destroy, an orphaned declaration and a
 * replacement. Given each one's registered removal policy, returns a sentence
 * for every one that would be deleted instead.
 */
export function unretainedStorage(
  resources: readonly { readonly LogicalId: string; readonly RemovalPolicy: string }[],
): string[] {
  return resources
    .filter((resource) => resource.RemovalPolicy !== "retain")
    .map(
      (resource) =>
        `${resource.LogicalId} has removal policy ${resource.RemovalPolicy}; adopted storage must be retained`,
    );
}
