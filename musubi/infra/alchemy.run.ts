import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  apiWorker,
  assertDevDeployTarget,
  assertSiteBuiltFor,
  assertStackRetained,
  flattenMigrations,
  origin,
  readDevDomain,
  refuseDotEnvFiles,
  requireSecrets,
  requireSeedValue,
  retainedD1,
  siteWorker,
  stackOptions,
  stageHosts,
} from "@shared/infra";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import { musubiDeclaration, type BindingDescription } from "./src/declaration";
import { osnSeedSql } from "./src/seeds";

/** osn/db's Drizzle migrations, flattened for Alchemy on every run. */
const OSN_MIGRATIONS = "../../osn/db/drizzle";

class UnresolvedBindingError extends Data.TaggedError("UnresolvedBindingError")<{
  readonly binding: string;
  readonly message: string;
}> {}

/** Each described binding as the value Alchemy binds: a database this stack declares, or a rate limiter. */
function toBindings(
  described: Readonly<Record<string, BindingDescription>>,
  databases: Readonly<Record<string, Cloudflare.D1.Database>>,
): Cloudflare.WorkerBindingProps {
  return Object.fromEntries(
    Object.entries(described).map(([name, binding]) => {
      if (binding.kind === "ratelimit") {
        return [
          name,
          Cloudflare.RateLimit(name, {
            namespaceId: binding.namespaceId,
            simple: { limit: binding.limit, period: binding.period },
          }),
        ];
      }
      const database = databases[name];
      if (database === undefined) {
        throw new UnresolvedBindingError({
          binding: name,
          message: `No database is declared for the D1 binding ${name}.`,
        });
      }
      return [name, database];
    }),
  );
}

function writeSeed(path: string, sql: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sql);
}

/**
 * The musubi stack: osn-api with its database and seed, musubi social and
 * musubi landing. Every value is read and checked, and each prebuilt site
 * is checked to be built for the stage's hosts, before anything is written
 * or declared, so a refused run writes nothing. Paths are relative to the
 * working directory, `musubi/infra`. `workingDir` names that directory to
 * the checks: the `.env` files Bun would load from it are refused, and the
 * site paths resolve from it.
 */
export const musubiStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generatedDir: string;
  readonly workingDir: string;
}) =>
  Effect.gen(function* () {
    const { env, generatedDir } = input;
    refuseDotEnvFiles(input.workingDir);
    const stage = assertDevDeployTarget(yield* Alchemy.Stage, env);
    const hosts = stageHosts(readDevDomain(env), stage);
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
    const osnApi = yield* apiWorker("OsnApi", {
      ...declared.osnApi,
      bindings: toBindings(declared.osnApi.bindings, { DB: db }),
      secrets,
    });
    const social = yield* siteWorker("MusubiSocial", declared.musubiSocial);
    const landing = yield* siteWorker("MusubiLanding", declared.musubiLanding);
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
