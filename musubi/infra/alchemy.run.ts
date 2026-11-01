import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  apiWorker,
  assertDeployTarget,
  assertProductionScope,
  assertSiteBuiltFor,
  assertStackRetained,
  flattenMigrations,
  hostsFor,
  origin,
  PRODUCTION_SITE_MODES,
  productionSiteKinds,
  refuseDotEnvFiles,
  requireSecrets,
  requireSeedValue,
  retainedD1,
  siteWorker,
  stackOptions,
  tierOf,
  type SiteMode,
  type SiteSurface,
} from "@shared/infra";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import {
  musubiDeclaration,
  musubiProductionSites,
  SITE_LOGICAL_IDS,
  type BindingDescription,
} from "./src/declaration";
import { osnSeedSql } from "./src/seeds";

/** osn/db's Drizzle migrations, flattened for Alchemy on every run. */
const OSN_MIGRATIONS = "../../osn/db/drizzle";

class UnresolvedBindingError extends Data.TaggedError("UnresolvedBindingError")<{
  readonly binding: string;
  readonly message: string;
}> {}

/**
 * Each described binding as the value Alchemy binds: a database this stack
 * declares, a rate limiter, or a Durable Object namespace the Worker hosts.
 */
function toBindings(
  described: Readonly<Record<string, BindingDescription>>,
  databases: Readonly<Record<string, Cloudflare.D1.Database>>,
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
        case "durable-object":
          // No script name: the class lives on this Worker, which exports it.
          return [name, Cloudflare.DurableObject(binding.className)];
        case "d1": {
          const database = databases[name];
          if (database === undefined) {
            throw new UnresolvedBindingError({
              binding: name,
              message: `No database is declared for the D1 binding ${name}.`,
            });
          }
          return [name, database];
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
 * The musubi stack on production: each site `modes` does not turn off,
 * built for production and checked to be, under today's name. It reads no
 * secret or seed value, writes no file, and declares neither osn-api nor
 * its database; anything else declared fails the scope check before the
 * plan.
 */
const musubiProductionStack = (input: {
  readonly stage: string;
  readonly workingDir: string;
  readonly modes: Readonly<Record<SiteSurface, SiteMode>>;
}) =>
  Effect.gen(function* () {
    const declared = musubiProductionSites({
      modes: input.modes,
      hosts: hostsFor(input.stage, {}),
    });
    for (const site of declared.prebuilt) {
      assertSiteBuiltFor({ ...site, directory: join(input.workingDir, site.directory) });
    }
    const workers = [];
    for (const [logicalId, site] of Object.entries(declared.sites)) {
      workers.push(yield* siteWorker(logicalId, site));
    }
    assertStackRetained({ stage: input.stage, storage: [], workers });
    assertProductionScope({
      stage: input.stage,
      resources: workers,
      allowed: Object.keys(productionSiteKinds(SITE_LOGICAL_IDS, input.modes)),
    });
    return Object.fromEntries(
      Object.entries(declared.sites).map(([logicalId, site]) => [logicalId, site.domain]),
    );
  });

/**
 * The musubi stack: osn-api with its database and seed, musubi social and
 * musubi landing. Every value is read and checked, and each prebuilt site
 * is checked to be built for the stage's hosts, before anything is written
 * or declared, so a refused run writes nothing. Paths are relative to the
 * working directory, `musubi/infra`. `workingDir` names that directory to
 * the checks: the `.env` files Bun would load from it are refused, and the
 * site paths resolve from it. On production it declares the sites alone,
 * at `modes` (PRODUCTION_SITE_MODES unless a test passes its own).
 */
export const musubiStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generatedDir: string;
  readonly workingDir: string;
  readonly modes?: Readonly<Record<SiteSurface, SiteMode>>;
}) =>
  Effect.gen(function* () {
    const { env, generatedDir } = input;
    refuseDotEnvFiles(input.workingDir);
    const stage = assertDeployTarget(yield* Alchemy.Stage, env);
    if (tierOf(stage) === "production") {
      return yield* musubiProductionStack({
        stage,
        workingDir: input.workingDir,
        modes: input.modes ?? PRODUCTION_SITE_MODES,
      });
    }
    const hosts = hostsFor(stage, env);
    const declared = musubiDeclaration({ stage, hosts, generatedDir });
    for (const site of declared.prebuilt) {
      assertSiteBuiltFor({ ...site, directory: join(input.workingDir, site.directory) });
    }
    const secrets = requireSecrets({ worker: "osn-api", stage, env });
    const seed = osnSeedSql({
      cireApiOrigin: origin(hosts.cireApi),
      // The deploy step's cire_seed outputs; it holds no cire secret.
      clientSecretSha256: requireSeedValue(env, "CIRE_OIDC_CLIENT_SECRET_SHA256"),
      arcKeyId: requireSeedValue(env, "CIRE_API_ARC_KEY_ID"),
      arcPublicJwk: requireSeedValue(env, "CIRE_API_ARC_PUBLIC_JWK"),
    });

    flattenMigrations({ source: OSN_MIGRATIONS, target: declared.osnDb.migrations });
    writeSeed(declared.seeds.osn, seed);

    // Logical ids key the state rows, so they never change: a renamed id is a new resource.
    const db = yield* retainedD1("OsnDb", declared.osnDb);
    // Binding `db` makes osn-api wait for the database's reconcile, which
    // applies osn/db's migrations, so the Worker never serves before a table
    // it reads exists.
    const osnApi = yield* apiWorker("OsnApi", {
      ...declared.osnApi,
      bindings: toBindings(declared.osnApi.bindings, { DB: db }),
      secrets,
    });
    const social = yield* siteWorker(SITE_LOGICAL_IDS.osn_social, declared.musubiSocial);
    const landing = yield* siteWorker(SITE_LOGICAL_IDS.musubi_landing, declared.musubiLanding);
    assertStackRetained({ stage, storage: [db], workers: [osnApi, social, landing] });
    return {
      osnApi: hosts.osnApi,
      musubiSocial: hosts.musubiSocial,
      musubiLanding: hosts.musubiLanding,
    };
  });

export default Alchemy.Stack(
  "musubi",
  stackOptions(),
  musubiStack({ env: process.env, generatedDir: ".generated", workingDir: process.cwd() }),
);
