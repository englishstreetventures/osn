import {
  apiWorker,
  assertDevDeployTarget,
  assertStackRetained,
  flattenMigrations,
  readDevDomain,
  refuseDotEnvFiles,
  requireSecrets,
  retainedD1,
  stackOptions,
  stageHosts,
} from "@shared/infra";
import * as Alchemy from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import { zapDeclaration, type BindingDescription } from "./src/declaration";

/** zap/db's Drizzle migrations, flattened for Alchemy on every run. */
const ZAP_MIGRATIONS = "../db/drizzle";

class UnresolvedBindingError extends Data.TaggedError("UnresolvedBindingError")<{
  readonly binding: string;
  readonly message: string;
}> {}

/**
 * Each described binding as the value Alchemy binds: a database this stack
 * declares, resolved by the binding's name, so it can only reach this
 * stack's database.
 */
function toBindings(
  described: Readonly<Record<string, BindingDescription>>,
  databases: Readonly<Record<string, Cloudflare.D1.Database>>,
): Cloudflare.WorkerBindingProps {
  return Object.fromEntries(
    Object.keys(described).map((name) => {
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

/**
 * The zap stack: zap-api and its database. Every value is read and checked
 * before anything is written or declared, so a refused run writes nothing.
 * Paths are relative to the working directory, `zap/infra`. `workingDir`
 * names that directory to the check that refuses the `.env` files Bun would
 * load from it.
 */
export const zapStack = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generatedDir: string;
  readonly workingDir: string;
}) =>
  Effect.gen(function* () {
    const { env, generatedDir } = input;
    refuseDotEnvFiles(input.workingDir);
    const stage = assertDevDeployTarget(yield* Alchemy.Stage, env);
    const hosts = stageHosts(readDevDomain(env), stage);
    const declared = zapDeclaration({ stage, hosts, generatedDir });
    const secrets = requireSecrets({ worker: "zap-api", stage, env });

    flattenMigrations({ source: ZAP_MIGRATIONS, target: declared.zapDb.migrations });

    // Logical ids key the state rows, so they never change: a renamed id is a new resource.
    const db = yield* retainedD1("ZapDb", declared.zapDb);
    const zapApi = yield* apiWorker("ZapApi", {
      ...declared.zapApi,
      bindings: toBindings(declared.zapApi.bindings, { DB: db }),
      secrets,
    });
    assertStackRetained({ stage, storage: [db], workers: [zapApi] });
    return { zapApi: hosts.zapApi };
  });

export default Alchemy.Stack(
  "zap",
  stackOptions(),
  zapStack({ env: process.env, generatedDir: ".generated", workingDir: process.cwd() }),
);
