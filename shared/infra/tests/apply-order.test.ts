/**
 * The order the installed Alchemy engine reconciles a database and the
 * Worker that binds it, which is what holds a migration before the Worker
 * version that needs it. The stack is declared with the repository's own
 * wrappers (`retainedD1`, `apiWorker`) and the Worker binds the database as
 * every production stack binds it (`bindings: { DB: db }`); scripted
 * providers for `Cloudflare.D1Database` and `Cloudflare.Worker` record when
 * each reconcile starts and ends, and the plan and apply are Alchemy's own
 * (`alchemy/Plan`, `alchemy/Apply`), on in-memory state.
 */

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Alchemy from "alchemy";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import * as Apply from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { evalStack } from "alchemy/EvalStack";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, test } from "vitest";

import { apiWorker, retainedD1 } from "../src/declare";

/** What the scripted providers saw, in order. */
type Event = "db:start" | "db:end" | "worker:start" | "worker:end";

/** What a scripted `read` is handed: the resource's last output, if any. */
interface ReadInput {
  readonly output?: unknown;
}

/** What the scripted database's `reconcile` reads of the declared props. */
interface DatabaseNews {
  readonly news: { readonly name?: string; readonly readReplication?: unknown };
}

/**
 * Scripted providers: every diff asks for an update; the database's reconcile
 * can fail. Each is cast to the provider shape, whose full type the scripts
 * do not fill in.
 */
function providers(events: Event[], failDatabase: boolean) {
  const database = Provider.succeed(Cloudflare.D1.Database, {
    diff: () => Effect.succeed({ action: "update" } as const),
    read: ({ output }: ReadInput) => Effect.succeed(output),
    reconcile: ({ news }: DatabaseNews) =>
      Effect.gen(function* () {
        events.push("db:start");
        // Long enough that a Worker that did not wait would start first.
        yield* Effect.sleep("50 millis");
        if (failDatabase) return yield* Effect.die("a migration failed");
        events.push("db:end");
        return {
          databaseId: "database-id",
          databaseName: news.name ?? "osn-db-prod",
          jurisdiction: "default" as const,
          readReplication: news.readReplication,
          accountId: "account",
          migrationsDir: undefined,
          migrationsTable: undefined,
          migrationsHashes: {},
          importHashes: {},
        };
      }),
    delete: () => Effect.void,
  } as never);
  const worker = Provider.succeed(
    Cloudflare.Worker as never,
    {
      diff: () => Effect.succeed({ action: "update" } as const),
      read: ({ output }: ReadInput) => Effect.succeed(output),
      reconcile: () =>
        Effect.sync(() => {
          events.push("worker:start");
          events.push("worker:end");
          return {} as never;
        }),
      delete: () => Effect.void,
    } as never,
  );
  return Layer.mergeAll(database, worker);
}

/** A stack of one database and the API Worker that binds it, as the production stacks declare them. */
const stack = (events: Event[], failDatabase: boolean) =>
  Alchemy.Stack(
    "order",
    { providers: providers(events, failDatabase) as never, state: Alchemy.inMemoryState() },
    Effect.gen(function* () {
      const db = yield* retainedD1("OsnDb", {
        name: "osn-db-prod",
        stage: "production",
        readReplication: "disabled",
        jurisdiction: "default",
        locationHint: null,
        migrations: ".generated/migrations/osn-db",
        importFiles: [],
      });
      yield* apiWorker("OsnApi", {
        worker: "osn-api",
        name: "osn-api-production",
        stage: "production",
        main: "../../osn/api/src/entry.ts",
        bundle: true,
        assets: null,
        compatibility: { date: "2025-03-01", flags: ["nodejs_compat"] },
        domain: null,
        crons: [],
        workersDev: false,
        previewUrls: false,
        vars: {},
        bindings: { DB: db },
        secrets: {},
        observability: {
          logs: true,
          headSamplingRate: 1,
          redactQueryString: true,
          traces: { enabled: false },
          invocationLogs: false,
          issues: true,
        },
      });
    }),
  );

const cliServices = Layer.mergeAll(
  AlchemyContextLive,
  Alchemy.inMemoryState(),
  layerNonInteractive(),
  AuthProvidersLive,
).pipe(Layer.provideMerge(BunServices.layer));

/**
 * Applies the stack on one state three times: the first creates both
 * resources; the second updates both, as every release after the first does;
 * the third selects the database alone (`include`), as the stack job's
 * migrate step does. Returns what each pass saw; a pass that fails ends the run.
 */
async function apply(failDatabase: boolean) {
  const events: Event[] = [];
  const seen: Event[][] = [];
  const exit = await Effect.runPromiseExit(
    evalStack(
      stack(events, failDatabase) as never,
      (compiled) =>
        Effect.gen(function* () {
          for (const include of [undefined, undefined, ["OsnDb"]]) {
            events.length = 0;
            const plan = yield* Plan.make(
              compiled as never,
              (include === undefined ? {} : { include }) as never,
            );
            const applied = yield* Effect.exit(Apply.apply(plan));
            seen.push([...events]);
            if (Exit.isFailure(applied)) return yield* applied;
          }
        }),
      { stage: "production" },
    ).pipe(provideFreshArtifactStore, Effect.provide(cliServices)) as Effect.Effect<
      unknown,
      unknown
    >,
  );
  return { exit, seen };
}

describe("the order a deploy reconciles a database and the Worker that binds it", () => {
  test("AO1: on create and on update, the Worker's upload starts after the database's reconcile, its migrations included, has ended", async () => {
    const { exit, seen } = await apply(false);
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
    expect(seen[0]).toEqual(["db:start", "db:end", "worker:start", "worker:end"]);
    expect(seen[1]).toEqual(["db:start", "db:end", "worker:start", "worker:end"]);
  });

  test("AO2: when the database's reconcile fails, the Worker is never uploaded", async () => {
    const { exit, seen } = await apply(true);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(seen).toEqual([["db:start"]]);
  });

  test("AO3: selecting the database, as the migrate step's `--include` does, reconciles the database alone", async () => {
    const { seen } = await apply(false);
    expect(seen[2]).toEqual(["db:start", "db:end"]);
  });
});
