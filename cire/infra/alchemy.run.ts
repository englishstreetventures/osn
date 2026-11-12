import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  apiWorker,
  assertDeployTarget,
  assertProductionScope,
  assertSiteBuiltFor,
  assertStackRetained,
  flattenMigrations,
  hostsFor,
  planPrebuiltStage,
  PRODUCTION_HOST_HOLDS,
  PRODUCTION_SITE_MODES,
  refuseDotEnvFiles,
  requireSecrets,
  retainedBucket,
  retainedD1,
  siteWorker,
  stackOptions,
  tierOf,
  writePrebuiltStage,
  type HostHold,
  type SiteMode,
  type SiteSurface,
} from "@shared/infra";
import * as Alchemy from "alchemy";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import {
  API_LOGICAL_IDS,
  cireDeclaration,
  cireProductionApis,
  cireProductionSites,
  productionResourceKinds,
  SITE_LOGICAL_IDS,
  type BindingDescription,
} from "./src/declaration";
import { ownerSeatSql } from "./src/seeds";

/** cire/db's migrations, flattened for Alchemy on every run. */
const CIRE_MIGRATIONS = "../db/migrations";

class UnresolvedBindingError extends Data.TaggedError("UnresolvedBindingError")<{
  readonly binding: string;
  readonly message: string;
}> {}

/**
 * Each described binding as the value Alchemy binds: a database or bucket
 * this stack declares, the Images service, a rate limiter, or a Durable
 * Object namespace the Worker hosts. A storage binding resolves by its name,
 * so it can only reach this stack's resources.
 */
function toBindings(
  described: Readonly<Record<string, BindingDescription>>,
  storage: {
    readonly databases: Readonly<Record<string, Cloudflare.D1.Database>>;
    readonly buckets: Readonly<Record<string, Cloudflare.R2.Bucket>>;
  },
): Cloudflare.WorkerBindingProps {
  return Object.fromEntries(
    Object.entries(described).map(([name, binding]) => {
      switch (binding.kind) {
        case "ratelimit":
          return [
            name,
            Cloudflare.RateLimit(name, {
              namespaceId: binding.namespaceId,
              simple: { limit: binding.limit, period: binding.period },
            }),
          ];
        case "images":
          return [name, Cloudflare.Images.Images(name)];
        case "durable-object":
          // No script name: the class lives on this Worker, which exports it.
          return [name, Cloudflare.DurableObject(binding.className)];
        case "d1":
        case "r2": {
          const resource = binding.kind === "d1" ? storage.databases[name] : storage.buckets[name];
          if (resource === undefined) {
            throw new UnresolvedBindingError({
              binding: name,
              message: `No ${binding.kind === "d1" ? "database" : "bucket"} is declared for the ${binding.kind} binding ${name}.`,
            });
          }
          return [name, resource];
        }
      }
    }),
  );
}

function writeSeed(path: string, sql: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sql);
}

/**
 * The cire stack on production: cire-api with its database and buckets and
 * the guest site's Worker, each adopted under today's name, and each site
 * `modes` does not turn off, with no custom domain while `holds` holds its
 * host. Every build is checked to be production's before anything is written
 * or declared. It reads no secret (production's stay on the Workers), writes
 * only the guest site's staged server output, and migrates nothing: Wrangler
 * migrates cire-db in the stack job before the deploy. Anything else declared
 * fails the scope check before the plan.
 */
const cireProductionStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stage: string;
  readonly generatedDir: string;
  readonly workingDir: string;
  readonly modes: Readonly<Record<SiteSurface, SiteMode>>;
  readonly holds: readonly HostHold[];
}) =>
  Effect.gen(function* () {
    const { stage } = input;
    const hosts = hostsFor(stage, {});
    const sites = cireProductionSites({ modes: input.modes, holds: input.holds, hosts });
    const apis = cireProductionApis({ hosts, generatedDir: input.generatedDir });
    for (const site of [...apis.prebuilt, ...sites.prebuilt]) {
      assertSiteBuiltFor({ ...site, directory: join(input.workingDir, site.directory) });
    }
    // Read and checked here, written below.
    const invitesServer = planPrebuiltStage({
      source: join(input.workingDir, apis.invitesServer.source),
      main: apis.invitesServer.main,
    });
    const apiSecrets = requireSecrets({ worker: "cire-api", stage, env: input.env });
    const invitesSecrets = requireSecrets({ worker: "cire-invites", stage, env: input.env });

    writePrebuiltStage(invitesServer, apis.invitesServer.target);

    const db = yield* retainedD1("CireDb", apis.cireDb);
    const assets = yield* retainedBucket("CireAssets", apis.cireAssets);
    const sheets = yield* retainedBucket("CireSheets", apis.cireSheets);
    const cireApi = yield* apiWorker(API_LOGICAL_IDS.cire_api, {
      ...apis.cireApi,
      bindings: toBindings(apis.cireApi.bindings, {
        databases: { DB: db },
        buckets: { ASSETS: assets, SHEETS: sheets },
      }),
      secrets: apiSecrets,
    });
    const cireInvites = yield* apiWorker(API_LOGICAL_IDS.cire_invites, {
      ...apis.cireInvites,
      secrets: invitesSecrets,
    });
    const workers = [cireApi, cireInvites];
    for (const [logicalId, site] of Object.entries(sites.sites)) {
      workers.push(yield* siteWorker(logicalId, site));
    }
    const storage = [db, assets, sheets];
    assertStackRetained({ stage, storage, workers });
    assertProductionScope({
      stage,
      resources: [...storage, ...workers],
      allowed: Object.keys(productionResourceKinds(input.modes)),
    });
    return {
      cireApi: apis.cireApi.domain,
      cireInvites: apis.cireInvites.domain,
      ...Object.fromEntries(
        Object.entries(sites.sites).map(([logicalId, site]) => [logicalId, site.domain]),
      ),
    };
  });

/**
 * The cire stack: cire-api with its database, buckets and seeds,
 * cire-invites from its prebuilt Astro output, staged with its source maps,
 * and the host, vendor and landing sites. Every value is read and checked,
 * each prebuilt site is checked to be built for the stage's hosts, and the
 * guest site's staging is worked out, before anything is written or
 * declared, so a refused run writes nothing. Paths are relative to the
 * working directory, `cire/infra`. `workingDir` names that directory to the
 * checks: the `.env` files Bun would load from it are refused, and the site
 * paths resolve from it. On production it declares the sites alone, at
 * `modes` and `holds` (PRODUCTION_SITE_MODES and PRODUCTION_HOST_HOLDS
 * unless a test passes its own).
 */
export const cireStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generatedDir: string;
  readonly workingDir: string;
  readonly modes?: Readonly<Record<SiteSurface, SiteMode>>;
  readonly holds?: readonly HostHold[];
}) =>
  Effect.gen(function* () {
    const { env, generatedDir } = input;
    refuseDotEnvFiles(input.workingDir);
    const stage = assertDeployTarget(yield* Alchemy.Stage, env);
    if (tierOf(stage) === "production") {
      return yield* cireProductionStack({
        env,
        stage,
        generatedDir,
        workingDir: input.workingDir,
        modes: input.modes ?? PRODUCTION_SITE_MODES,
        holds: input.holds ?? PRODUCTION_HOST_HOLDS,
      });
    }
    const hosts = hostsFor(stage, env);
    // A GitHub variable, not a secret: the profile that owns the seeded wedding.
    const ownerSeat = ownerSeatSql(env.CIRE_DEV_OWNER_PROFILE_ID);
    const declared = cireDeclaration({
      stage,
      hosts,
      generatedDir,
      ownerSeat: ownerSeat !== null,
    });
    for (const site of declared.prebuilt) {
      assertSiteBuiltFor({ ...site, directory: join(input.workingDir, site.directory) });
    }
    // Read and checked here, written below with the other generated files.
    const invitesServer = planPrebuiltStage({
      source: join(input.workingDir, declared.invitesServer.source),
      main: declared.invitesServer.main,
    });
    const apiSecrets = requireSecrets({ worker: "cire-api", stage, env });
    const invitesSecrets = requireSecrets({ worker: "cire-invites", stage, env });

    flattenMigrations({ source: CIRE_MIGRATIONS, target: declared.cireDb.migrations });
    if (ownerSeat !== null) writeSeed(declared.seeds.ownerSeat, ownerSeat);
    writePrebuiltStage(invitesServer, declared.invitesServer.target);

    // Logical ids key the state rows, so they never change: a renamed id is a new resource.
    const db = yield* retainedD1("CireDb", declared.cireDb);
    const assets = yield* retainedBucket("CireAssets", declared.cireAssets);
    const sheets = yield* retainedBucket("CireSheets", declared.cireSheets);
    const cireApi = yield* apiWorker("CireApi", {
      ...declared.cireApi,
      bindings: toBindings(declared.cireApi.bindings, {
        databases: { DB: db },
        buckets: { ASSETS: assets, SHEETS: sheets },
      }),
      secrets: apiSecrets,
    });
    const cireInvites = yield* apiWorker("CireInvites", {
      ...declared.cireInvites,
      secrets: invitesSecrets,
    });
    const host = yield* siteWorker(SITE_LOGICAL_IDS.cire_host, declared.cireHost);
    const vendor = yield* siteWorker(SITE_LOGICAL_IDS.cire_vendor, declared.cireVendor);
    const landing = yield* siteWorker(SITE_LOGICAL_IDS.cire_landing, declared.cireLanding);
    assertStackRetained({
      stage,
      storage: [db, assets, sheets],
      workers: [cireApi, cireInvites, host, vendor, landing],
    });
    return {
      cireApi: hosts.cireApi,
      cireInvites: hosts.cireInvites,
      cireHost: hosts.cireHost,
      cireVendor: hosts.cireVendor,
      cireLanding: hosts.cireLanding,
    };
  });

export default Alchemy.Stack(
  "cire",
  stackOptions(),
  cireStack({ env: process.env, generatedDir: ".generated", workingDir: process.cwd() }),
);
