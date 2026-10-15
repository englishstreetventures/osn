/**
 * The read-only check `alchemy.run.ts` runs before it declares the adopted
 * dev storage.
 *
 * Alchemy follows every adoption with an update that rewrites a resource's
 * mutable settings to the declaration: an R2 bucket's storage class,
 * lifecycle rules, CORS rules and r2.dev access, and a D1 database's read
 * replication. The probe declares exactly what the dev tier has, and this
 * check refuses the run unless the live resources still match. When it
 * passes, that update has nothing to write, so adopting never changes the
 * dev buckets or databases. It also refuses when a bucket or database is
 * missing, so the stack can never create one, and when a database's id is
 * not the pinned dev id.
 *
 * The comparison is the one Alchemy makes, not a looser one: live rules are
 * normalised the way its R2 provider normalises them and compared with its
 * own `deepEqual`, so a rule that matches in meaning but differs in shape is
 * refused here instead of being rewritten there.
 */
import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import type * as Cloudflare from "alchemy/Cloudflare";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import { deepEqual } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

type LifecycleRule = Cloudflare.R2.BucketLifecycleRule;
type CorsRule = Cloudflare.R2.BucketCorsRule;

/** The R2 settings Alchemy's adoption update writes, as the stack declares them. */
export type BucketSettings = {
  storageClass: "Standard" | "InfrequentAccess";
  lifecycleRules: LifecycleRule[];
  cors: CorsRule[];
  publicAccess: boolean;
};

/** The D1 setting Alchemy's adoption update writes, as the stack declares it. */
export type DatabaseSettings = { readReplication: { mode: "auto" | "disabled" } };

/** What the dev buckets are configured with: nothing beyond Cloudflare's defaults. */
export const DEV_BUCKET_SETTINGS: BucketSettings = {
  storageClass: "Standard",
  lifecycleRules: [],
  cors: [],
  publicAccess: false,
};

export const DEV_DATABASE_SETTINGS: DatabaseSettings = { readReplication: { mode: "disabled" } };

export type DeclaredStorage = {
  readonly buckets: Readonly<Record<string, BucketSettings>>;
  readonly databases: Readonly<Record<string, DatabaseSettings & { readonly id: string }>>;
};

/** One bucket as the Cloudflare API reports it. */
export type LiveBucket = {
  readonly storageClass: string | null | undefined;
  readonly lifecycleRules: readonly r2.BucketsLifecycleGetResponseRulesItem[];
  readonly corsRules: readonly r2.BucketsCorsGetResponseRulesItem[];
  readonly publicAccess: boolean;
};

export type LiveDatabase = {
  readonly id: string;
  readonly readReplicationMode: string | undefined;
};

/** Live state by name; `undefined` means the resource does not exist. */
export type LiveStorage = {
  readonly buckets: Readonly<Record<string, LiveBucket | undefined>>;
  readonly databases: Readonly<Record<string, LiveDatabase | undefined>>;
};

// The two normalisations below are the ones `alchemy/Cloudflare/R2/Bucket.ts`
// applies before it decides whether to write lifecycle or CORS rules.
const liveLifecycleRule = (rule: r2.BucketsLifecycleGetResponseRulesItem) => ({
  id: rule.id,
  enabled: rule.enabled,
  prefix: rule.conditions.prefix ?? "",
  abortMultipartUploadsTransition: rule.abortMultipartUploadsTransition
    ? { condition: rule.abortMultipartUploadsTransition.condition ?? undefined }
    : undefined,
  deleteObjectsTransition: rule.deleteObjectsTransition
    ? { condition: rule.deleteObjectsTransition.condition ?? undefined }
    : undefined,
  storageClassTransitions: rule.storageClassTransitions ?? undefined,
});

const declaredLifecycleRule = (rule: LifecycleRule) => ({
  id: rule.id,
  enabled: rule.enabled ?? true,
  prefix: rule.prefix ?? "",
  abortMultipartUploadsTransition: rule.abortMultipartUploadsTransition
    ? { condition: rule.abortMultipartUploadsTransition.condition }
    : undefined,
  deleteObjectsTransition: rule.deleteObjectsTransition
    ? { condition: rule.deleteObjectsTransition.condition }
    : undefined,
  storageClassTransitions: rule.storageClassTransitions,
});

const liveCorsRule = (rule: r2.BucketsCorsGetResponseRulesItem) => ({
  id: rule.id ?? undefined,
  allowedMethods: rule.allowed.methods,
  allowedOrigins: rule.allowed.origins,
  allowedHeaders: rule.allowed.headers ?? undefined,
  exposeHeaders: rule.exposeHeaders ?? undefined,
  maxAgeSeconds: rule.maxAgeSeconds ?? undefined,
});

const declaredCorsRule = (rule: CorsRule) => ({
  id: rule.id,
  allowedMethods: rule.allowedMethods,
  allowedOrigins: rule.allowedOrigins,
  allowedHeaders: rule.allowedHeaders,
  exposeHeaders: rule.exposeHeaders,
  maxAgeSeconds: rule.maxAgeSeconds,
});

const show = (value: unknown) => JSON.stringify(value);

/**
 * Every way the live storage differs from the declaration, one sentence each.
 * Empty means Alchemy's adoption update has nothing to write.
 */
export function storageFindings(declared: DeclaredStorage, live: LiveStorage): string[] {
  const findings: string[] = [];

  for (const [name, want] of Object.entries(declared.buckets)) {
    const have = live.buckets[name];
    if (!have) {
      findings.push(`R2 bucket ${name} does not exist; the probe adopts it and never creates it`);
      continue;
    }
    const storageClass = have.storageClass ?? "Standard";
    if (storageClass !== want.storageClass) {
      findings.push(
        `R2 bucket ${name} storage class is ${storageClass}, declared ${want.storageClass}`,
      );
    }
    const liveRules = have.lifecycleRules.map(liveLifecycleRule);
    const wantRules = want.lifecycleRules.map(declaredLifecycleRule);
    if (!deepEqual(liveRules, wantRules)) {
      findings.push(
        `R2 bucket ${name} lifecycle rules are ${show(liveRules)}, declared ${show(wantRules)}`,
      );
    }
    const liveCors = have.corsRules.map(liveCorsRule);
    const wantCors = want.cors.map(declaredCorsRule);
    if (!deepEqual(liveCors, wantCors)) {
      findings.push(
        `R2 bucket ${name} CORS rules are ${show(liveCors)}, declared ${show(wantCors)}`,
      );
    }
    if (have.publicAccess !== want.publicAccess) {
      findings.push(
        `R2 bucket ${name} public r2.dev access is ${have.publicAccess ? "on" : "off"}, declared ${want.publicAccess ? "on" : "off"}`,
      );
    }
  }

  for (const [name, want] of Object.entries(declared.databases)) {
    const have = live.databases[name];
    if (!have) {
      findings.push(`D1 database ${name} does not exist; the probe adopts it and never creates it`);
      continue;
    }
    if (have.id !== want.id) {
      findings.push(`D1 database ${name} is ${have.id}, not the pinned dev database ${want.id}`);
    }
    const mode = have.readReplicationMode ?? "disabled";
    if (mode !== want.readReplication.mode) {
      findings.push(
        `D1 database ${name} read replication is ${mode}, declared ${want.readReplication.mode}`,
      );
    }
  }
  return findings;
}

/** Names the read that failed, so a refused run says which call to look at. */
const reading =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Error, R> =>
    effect.pipe(Effect.mapError((cause) => new Error(`Reading ${what} failed`, { cause })));

/**
 * Reads the live settings with the same calls Alchemy's R2 and D1 providers
 * make, in the default jurisdiction they use. Read-only.
 */
export const readLiveStorage = (bucketNames: readonly string[], databaseNames: readonly string[]) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    const buckets: Record<string, LiveBucket | undefined> = {};
    for (const bucketName of bucketNames) {
      const found = yield* r2.getBucket({ accountId, bucketName }).pipe(
        Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
        reading(`R2 bucket ${bucketName}`),
      );
      if (!found) {
        buckets[bucketName] = undefined;
        continue;
      }
      const lifecycle = yield* r2
        .getBucketLifecycle({ accountId, bucketName })
        .pipe(reading(`R2 bucket ${bucketName} lifecycle rules`));
      const corsRules = yield* r2.getBucketCors({ accountId, bucketName }).pipe(
        Effect.map((response) => response.rules ?? []),
        Effect.catchTag("NoCorsConfiguration", () => Effect.succeed([])),
        reading(`R2 bucket ${bucketName} CORS rules`),
      );
      const managed = yield* r2
        .listBucketDomainManageds({ accountId, bucketName })
        .pipe(reading(`R2 bucket ${bucketName} r2.dev access`));
      buckets[bucketName] = {
        storageClass: found.storageClass,
        lifecycleRules: lifecycle.rules ?? [],
        corsRules,
        publicAccess: managed.enabled,
      };
    }

    const databases: Record<string, LiveDatabase | undefined> = {};
    for (const name of databaseNames) {
      const match = yield* d1.listDatabases.items({ accountId, name }).pipe(
        Stream.filter((db) => db.name === name),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
        reading(`the D1 database list for ${name}`),
      );
      if (!match?.uuid) {
        databases[name] = undefined;
        continue;
      }
      const database = yield* d1
        .getDatabase({ accountId, databaseId: match.uuid })
        .pipe(reading(`D1 database ${name}`));
      databases[name] = { id: match.uuid, readReplicationMode: database.readReplication?.mode };
    }

    return { buckets, databases } satisfies LiveStorage;
  });

/** Fails the run, naming every difference, unless live storage matches the declaration. */
export const checkAdoptedStorage = (declared: DeclaredStorage) =>
  readLiveStorage(Object.keys(declared.buckets), Object.keys(declared.databases)).pipe(
    Effect.orDie,
    Effect.flatMap((live) => {
      const findings = storageFindings(declared, live);
      return findings.length === 0
        ? Effect.void
        : Effect.die(
            new Error(
              `Refusing to adopt dev storage whose live settings differ from the declaration in alchemy.run.ts:\n- ${findings.join("\n- ")}`,
            ),
          );
    }),
  );
