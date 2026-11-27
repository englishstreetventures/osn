import type * as Cloudflare from "@alchemy.run/cloudflare";
import {
  apiWorker,
  assertDeployTarget,
  assertProductionScope,
  assertStackRetained,
  flattenMigrations,
  hostsFor,
  refuseDotEnvFiles,
  requireSecrets,
  retainedBucket,
  retainedD1,
  stackOptions,
  tierOf,
} from "@shared/infra";
import * as Alchemy from "alchemy";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import {
  API_LOGICAL_IDS,
  PRODUCTION_RESOURCE_KINDS,
  ZAP_DB_MIGRATIONS,
  ZAP_DB_PRODUCTION_MIGRATIONS,
  zapDeclaration,
  zapProductionApis,
  type BindingDescription,
} from "./src/declaration";

class UnresolvedBindingError extends Data.TaggedError("UnresolvedBindingError")<{
  readonly binding: string;
  readonly message: string;
}> {}

/**
 * Each described binding as the value Alchemy binds: a database or bucket
 * this stack declares, resolved by the binding's name, so it can only reach
 * this stack's storage.
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
      const resource = binding.kind === "d1" ? storage.databases[name] : storage.buckets[name];
      if (resource === undefined) {
        throw new UnresolvedBindingError({
          binding: name,
          message: `No ${binding.kind === "d1" ? "database" : "bucket"} is declared for the ${binding.kind} binding ${name}.`,
        });
      }
      return [name, resource];
    }),
  );
}

/**
 * The zap stack on production: zap-api and its database, each adopted under
 * today's name. It reads no secret (production's stay on the Worker), and
 * writes only zap-db-prod's migrations, which Alchemy applies in the stack
 * job's migrate step, before the deploy. Anything else declared fails the
 * scope check before the plan.
 */
const zapProductionStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stage: string;
  readonly generatedDir: string;
}) =>
  Effect.gen(function* () {
    const { stage } = input;
    const apis = zapProductionApis({
      hosts: hostsFor(stage, {}),
      generatedDir: input.generatedDir,
    });
    const secrets = requireSecrets({ worker: "zap-api", stage, env: input.env });
    flattenMigrations({ ...ZAP_DB_PRODUCTION_MIGRATIONS, target: apis.zapDb.migrations });
    // Binding `db` makes zap-api wait for the database's reconcile, which
    // applies its migrations.
    const db = yield* retainedD1("ZapDb", apis.zapDb);
    const deletionRecords = yield* retainedBucket("ZapDeletionRecords", apis.zapDeletionRecords);
    const zapApi = yield* apiWorker(API_LOGICAL_IDS.zap_api, {
      ...apis.zapApi,
      bindings: toBindings(apis.zapApi.bindings, {
        databases: { DB: db },
        buckets: { DELETION_RECORDS: deletionRecords },
      }),
      secrets,
    });
    assertStackRetained({ stage, storage: [db, deletionRecords], workers: [zapApi] });
    assertProductionScope({
      stage,
      resources: [db, deletionRecords, zapApi],
      allowed: Object.keys(PRODUCTION_RESOURCE_KINDS),
    });
    return { zapApi: apis.zapApi.domain };
  });

/**
 * The zap stack: zap-api and its database. Every value is read and checked
 * before anything is written or declared, so a refused run writes nothing.
 * Paths are relative to the working directory, `zap/infra`. `workingDir`
 * names that directory to the check that refuses the `.env` files Bun would
 * load from it. On production it adopts zap-api and its database.
 */
export const zapStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generatedDir: string;
  readonly workingDir: string;
}) =>
  Effect.gen(function* () {
    const { env, generatedDir } = input;
    refuseDotEnvFiles(input.workingDir);
    const stage = assertDeployTarget(yield* Alchemy.Stage, env);
    if (tierOf(stage) === "production") {
      return yield* zapProductionStack({ env, stage, generatedDir });
    }
    const hosts = hostsFor(stage, env);
    const declared = zapDeclaration({ stage, hosts, generatedDir });
    const secrets = requireSecrets({ worker: "zap-api", stage, env });

    flattenMigrations({ ...ZAP_DB_MIGRATIONS, target: declared.zapDb.migrations });

    // Logical ids key the state rows, so they never change: a renamed id is a new resource.
    const db = yield* retainedD1("ZapDb", declared.zapDb);
    const deletionRecords = yield* retainedBucket(
      "ZapDeletionRecords",
      declared.zapDeletionRecords,
    );
    const zapApi = yield* apiWorker("ZapApi", {
      ...declared.zapApi,
      bindings: toBindings(declared.zapApi.bindings, {
        databases: { DB: db },
        buckets: { DELETION_RECORDS: deletionRecords },
      }),
      secrets,
    });
    assertStackRetained({ stage, storage: [db, deletionRecords], workers: [zapApi] });
    return { zapApi: hosts.zapApi };
  });

export default Alchemy.Stack(
  "zap",
  stackOptions(),
  zapStack({ env: process.env, generatedDir: ".generated", workingDir: process.cwd() }),
);
