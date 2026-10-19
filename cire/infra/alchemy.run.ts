import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  apiWorker,
  assertDevDeployTarget,
  assertSiteBuiltFor,
  assertStackRetained,
  flattenMigrations,
  readDevDomain,
  refuseDotEnvFiles,
  requireSecrets,
  retainedBucket,
  retainedD1,
  siteWorker,
  stackOptions,
  stageHosts,
} from "@shared/infra";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import { cireDeclaration, type BindingDescription } from "./src/declaration";
import { ownerSeatSql } from "./src/seeds";

/** cire/db's migrations, flattened for Alchemy on every run. */
const CIRE_MIGRATIONS = "../db/migrations";

class UnresolvedBindingError extends Data.TaggedError("UnresolvedBindingError")<{
  readonly binding: string;
  readonly message: string;
}> {}

/**
 * Each described binding as the value Alchemy binds: a database or bucket
 * this stack declares, the Images service, or a rate limiter. A storage
 * binding resolves by its name, so it can only reach this stack's resources.
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
 * The cire stack: cire-api with its database, buckets and seeds,
 * cire-invites from its prebuilt Astro output, and the host, vendor and
 * landing sites. Every value is read and checked, and each prebuilt site is
 * checked to be built for the stage's hosts, before anything is written or
 * declared, so a refused run writes nothing. Paths are relative to the
 * working directory, `cire/infra`; `siteRoot` is the directory the site
 * paths resolve from for that check, the working directory when the CLI
 * runs the stack.
 */
export const cireStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generatedDir: string;
  readonly siteRoot: string;
}) =>
  Effect.gen(function* () {
    const { env, generatedDir } = input;
    refuseDotEnvFiles(process.cwd());
    const stage = assertDevDeployTarget(yield* Alchemy.Stage, env);
    const hosts = stageHosts(readDevDomain(env), stage);
    // A GitHub variable, not a secret: the profile that owns the seeded wedding.
    const ownerSeat = ownerSeatSql(env.CIRE_DEV_OWNER_PROFILE_ID);
    const declared = cireDeclaration({
      stage,
      hosts,
      generatedDir,
      ownerSeat: ownerSeat !== null,
    });
    for (const site of declared.prebuilt) {
      assertSiteBuiltFor({ ...site, directory: join(input.siteRoot, site.directory) });
    }
    const apiSecrets = requireSecrets({ worker: "cire-api", stage, env });
    const invitesSecrets = requireSecrets({ worker: "cire-invites", stage, env });

    flattenMigrations({ source: CIRE_MIGRATIONS, target: declared.cireDb.migrations });
    if (ownerSeat !== null) writeSeed(declared.seeds.ownerSeat, ownerSeat);

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
    const host = yield* siteWorker("CireHost", declared.cireHost);
    const vendor = yield* siteWorker("CireVendor", declared.cireVendor);
    const landing = yield* siteWorker("CireLanding", declared.cireLanding);
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
  cireStack({ env: process.env, generatedDir: ".generated", siteRoot: process.cwd() }),
);
