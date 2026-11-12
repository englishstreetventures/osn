/**
 * The move of each production database from Wrangler's migrator to
 * Alchemy's, proved on local D1 databases that Wrangler migrated the way it
 * migrated production.
 *
 * For cire-db, osn-db-prod and zap-db-prod, the Wrangler `cire/api` installs
 * (the version that migrated production) applies the database's history to a
 * local database: cire's archived chain file by file and then its live
 * directory, as production met them, osn's and zap's drizzle chains. Its `d1_migrations`
 * then holds what production's holds. The Alchemy Cloudflare provider's own
 * `read`, `diff` and `reconcile` for `Cloudflare.D1Database` then run against
 * that database through a scripted Cloudflare API, whose `/query` runs each
 * request's SQL on it in one batch, as Wrangler's local `d1 execute` does, and
 * records every SQL text. The migrations directory is the one each production
 * stack flattens, from the stack's own `*_PRODUCTION_MIGRATIONS`; the ledger
 * counts are the live read's (`readLedger`) and the plan guard's
 * (`judgeLedger`).
 *
 * Each case starts Wrangler and workerd, seconds apiece, so this is the D1
 * tier: `bun run --cwd shared/infra test:d1` sets INFRA_D1_TIER. It writes
 * `d1-artifacts/ledger-conversion.json`: per database and case, the ledger's
 * rows, every write sent, and the counts.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Credentials } from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as D1 from "@alchemy.run/cloudflare/D1/Database";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Provider from "alchemy/Provider";
import { Cause, Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { CIRE_DB_PRODUCTION_MIGRATIONS } from "../../../../cire/infra/src/declaration";
import { OSN_DB_PRODUCTION_MIGRATIONS } from "../../../../musubi/infra/src/declaration";
import { ZAP_DB_PRODUCTION_MIGRATIONS } from "../../../../zap/infra/src/declaration";
import {
  FREEZE_MIGRATION,
  flattenMigrations,
  migrationFiles,
  type MigrationSources,
} from "../../src/migrations";
import {
  judgeLedger,
  readLedger,
  type LedgerCounts,
  type LedgerRow,
} from "../../src/production-live";
import { retainedD1Props } from "../../src/storage";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const CIRE_API = join(REPO, "cire", "api");
const WRANGLER = join(CIRE_API, "node_modules", ".bin", "wrangler");
const TIER = process.env.INFRA_D1_TIER === "1";
const API = "https://api.cloudflare.test/client/v4";
const ACCOUNT = "account";

/** A statement of Wrangler's local D1 binding, as far as this file uses one. */
interface LocalStatement {
  all(): Promise<{ readonly results: Record<string, unknown>[] }>;
  run(): Promise<unknown>;
}

/** Wrangler's local D1 binding, as far as this file uses it. */
interface LocalD1 {
  prepare(sql: string): LocalStatement;
  batch(statements: LocalStatement[]): Promise<{ readonly results: unknown[] }[]>;
}

/** What this file uses of the Wrangler that binary runs: its local D1 and its SQL splitter. */
interface WranglerModule {
  readonly getPlatformProxy: (options: {
    readonly configPath: string;
    readonly persist: { readonly path: string };
  }) => Promise<{ readonly env: { readonly DB: LocalD1 }; readonly dispose: () => Promise<void> }>;
  readonly unstable_splitSqlQuery: (sql: string) => string[];
}

let wrangler: WranglerModule;

/** One production database, as its stack declares it and as Wrangler built it. */
interface Target {
  readonly name: string;
  /** The stack's directory, which its migration sources are relative to. */
  readonly stack: string;
  readonly sources: MigrationSources;
  /** The directories Wrangler applied production's history from, in order. */
  readonly history: readonly string[];
  readonly readReplication: "auto" | "disabled";
}

const TARGETS: readonly Target[] = [
  {
    name: "cire-db",
    stack: join(REPO, "cire", "infra"),
    sources: CIRE_DB_PRODUCTION_MIGRATIONS,
    history: [join(REPO, "cire/db/migrations-archive"), join(REPO, "cire/db/migrations")],
    readReplication: "auto",
  },
  {
    name: "osn-db-prod",
    stack: join(REPO, "musubi", "infra"),
    sources: OSN_DB_PRODUCTION_MIGRATIONS,
    history: [join(REPO, "osn/db/drizzle")],
    readReplication: "disabled",
  },
  {
    name: "zap-db-prod",
    stack: join(REPO, "zap", "infra"),
    sources: ZAP_DB_PRODUCTION_MIGRATIONS,
    history: [join(REPO, "zap/db/drizzle")],
    readReplication: "disabled",
  },
];

const [CIRE, , ZAP] = TARGETS as [Target, Target, Target];

let root: string;
const artifact: Record<string, Record<string, unknown>> = {};
const record = (target: Target, label: string, value: unknown) => {
  artifact[target.name] = { ...artifact[target.name], [label]: value };
};

/** A local D1 and the directory its Wrangler configs live in. */
interface LocalDb {
  readonly target: Target;
  readonly dir: string;
  readonly persist: string;
}

/** A Wrangler config naming the database under a local id, its migrations in `migrationsDir`. */
function configFor(db: LocalDb, migrationsDir: string): string {
  const path = join(db.dir, `wrangler-${migrationsDir.replaceAll(/[^a-z0-9]+/gi, "-")}.toml`);
  writeFileSync(
    path,
    [
      `name = "conversion-${db.target.name}"`,
      'compatibility_date = "2025-03-01"',
      "[[d1_databases]]",
      'binding = "DB"',
      `database_name = "${db.target.name}"`,
      `database_id = "local:${db.target.name}"`,
      `migrations_dir = "${migrationsDir}"`,
      "",
    ].join("\n"),
  );
  return path;
}

function wranglerRun(args: readonly string[]): {
  readonly exitCode: number;
  readonly output: string;
} {
  const result = spawnSync(WRANGLER, args, {
    cwd: CIRE_API,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    // Wrangler prints a table row per migration and per statement: cire's
    // archive alone passes spawnSync's default 1 MiB.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
  return { exitCode: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

/** Wrangler applies `migrationsDir` to the database, as `wrangler d1 migrations apply` did on production. */
const wranglerApply = (db: LocalDb, migrationsDir: string) =>
  wranglerRun([
    "d1",
    "migrations",
    "apply",
    db.target.name,
    "--local",
    "--persist-to",
    db.persist,
    "--config",
    configFor(db, migrationsDir),
  ]);

/** Each database's history, built once by Wrangler; every case works on a copy. */
const histories = new Map<string, LocalDb>();

function history(target: Target): LocalDb {
  const built = histories.get(target.name);
  if (built !== undefined) return built;
  const dir = join(root, `${target.name}-history`);
  mkdirSync(dir, { recursive: true });
  const db: LocalDb = { target, dir, persist: join(dir, "persist") };
  for (const migrations of target.history) {
    const applied = wranglerApply(db, migrations);
    if (applied.exitCode !== 0) {
      throw new Error(`wrangler could not apply ${migrations}:\n${applied.output}`);
    }
  }
  histories.set(target.name, db);
  return db;
}

/** A copy of `target`'s history, for a case to change. */
function copyOfHistory(target: Target, label: string): LocalDb {
  const dir = join(root, `${target.name}-${label}`);
  mkdirSync(dir, { recursive: true });
  cpSync(history(target).persist, join(dir, "persist"), { recursive: true });
  return { target, dir, persist: join(dir, "persist") };
}

/** The database through Wrangler's own local D1. */
const open = (db: LocalDb) =>
  wrangler.getPlatformProxy({
    configPath: configFor(db, db.target.history[0]!),
    persist: { path: join(db.persist, "v3") },
  });

const rows = async (DB: LocalD1, sql: string) => (await DB.prepare(sql).all()).results;

const names = async (DB: LocalD1, table: string) =>
  (await rows(DB, `SELECT name FROM "${table}" ORDER BY id`)).map((row) => String(row.name));

/** The schema and each table's row count: what a migration run twice, or a lost write, would change. */
async function snapshot(DB: LocalD1) {
  const objects = await rows(
    DB,
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  const counts: Record<string, unknown> = {};
  for (const { name } of objects.filter((object) => object.type === "table")) {
    // oxlint-disable-next-line no-await-in-loop -- one count per table, in order
    counts[String(name)] = (await rows(DB, `SELECT count(*) AS n FROM "${String(name)}"`))[0]?.n;
  }
  return { objects, counts };
}

/** The snapshot without Alchemy's ledger and the freeze, which are all a clean move may add. */
const withoutAlchemy = (taken: Awaited<ReturnType<typeof snapshot>>) => ({
  objects: taken.objects.filter(
    (object) => object.name !== "__alchemy_migrations" && object.name !== "d1_migrations_frozen",
  ),
  counts: Object.fromEntries(
    Object.entries(taken.counts).filter(([name]) => name !== "__alchemy_migrations"),
  ),
});

/** What the scripted API does with one `/query`: run it, run it and lose the reply, fail before it runs, or refuse it. */
type QueryAction = "run" | "lose-reply" | "fail-before" | "refuse";

/**
 * A scripted Cloudflare API over one local D1. `/query` runs the request's SQL
 * as one batch (Wrangler's split, then the binding's `batch`, which commits or
 * rolls back as one, as Cloudflare documents a failed migration rolling back)
 * and answers as Cloudflare does; a SQL error answers 400 with code 7500.
 * `sent` records every SQL text the provider asked it to run; `hook` decides
 * what happens to each.
 */
function cloudflare(DB: LocalD1, target: Target, hook: (sql: string) => QueryAction = () => "run") {
  const sent: string[] = [];
  const answer = (body: unknown, status: number) => Response.json(body, { status });
  const refused = (message: string) =>
    answer({ success: false, errors: [{ code: 7500, message }], messages: [], result: null }, 400);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^\/client\/v4/, "");
    if (
      request.method === "POST" &&
      path === `/accounts/${ACCOUNT}/d1/database/database-id/query`
    ) {
      const { sql } = (await request.json()) as { readonly sql: string };
      sent.push(sql);
      const action = hook(sql);
      if (action === "fail-before") return new Response("busy", { status: 503 });
      if (action === "refuse") return refused("refused by the scripted API");
      let results: { readonly results: unknown[] }[];
      try {
        const statements = wrangler.unstable_splitSqlQuery(sql);
        results = await DB.batch(statements.map((statement) => DB.prepare(statement)));
      } catch (error) {
        return refused(String(error));
      }
      if (action === "lose-reply") return new Response("lost", { status: 503 });
      return answer(
        {
          success: true,
          errors: [],
          messages: [],
          result: results.map((result) => ({ results: result.results, success: true, meta: {} })),
        },
        200,
      );
    }
    if (request.method === "GET" && path === `/accounts/${ACCOUNT}/d1/database`) {
      return answer(
        {
          success: true,
          errors: [],
          messages: [],
          result: [{ uuid: "database-id", name: target.name }],
          result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 },
        },
        200,
      );
    }
    if (request.method === "GET" && path === `/accounts/${ACCOUNT}/d1/database/database-id`) {
      return answer(
        {
          success: true,
          errors: [],
          messages: [],
          result: {
            uuid: "database-id",
            name: target.name,
            read_replication: { mode: target.readReplication },
          },
        },
        200,
      );
    }
    return answer({ success: false, errors: [{ code: 1, message: path }], result: null }, 404);
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

/** The D1 provider's attributes, as state holds them. */
type Attributes = D1.Database["Attributes"];

/** Runs `use` with the installed Alchemy D1 provider, reaching Cloudflare through `fetch`. */
function withProvider<A>(
  fetch: typeof globalThis.fetch,
  use: (provider: Provider.ProviderService<D1.Database>) => Effect.Effect<A, unknown, unknown>,
): Promise<Exit.Exit<A, unknown>> {
  const program = Effect.gen(function* () {
    const provider = yield* Provider.Provider<D1.Database>("Cloudflare.D1Database");
    return yield* use(provider);
  }).pipe(
    Effect.provide(D1.ProviderLive()),
    Effect.provideService(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("token"),
        accountId: ACCOUNT,
        source: { type: "env" as const },
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(
      Credentials,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("token"),
        apiBaseUrl: API,
      }),
    ),
    Effect.provide(BunServices.layer),
  );
  return Effect.runPromiseExit(program as Effect.Effect<A, unknown, never>);
}

const value = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
};

const failure = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected the provider to fail");
  const error = Cause.squash(exit.cause);
  return error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);
};

/** The production directory the stack flattens for `target`, under `dir`. */
const flattened = (target: Target, dir: string, sources: MigrationSources = target.sources) =>
  flattenMigrations({ ...sources, target: join(dir, "migrations") }, target.stack);

/** The props the production stack declares now, its migrations in `migrations`. */
const productionProps = (target: Target, migrations: string) =>
  retainedD1Props({
    name: target.name,
    stage: "production",
    readReplication: target.readReplication,
    jurisdiction: "default",
    locationHint: null,
    migrations,
    importFiles: [],
  });

/**
 * The state the adoption left: the provider's own `read` of the database by
 * name, given the props #2238 declared it with, which named no migrations.
 */
async function adoptedState(fetch: typeof globalThis.fetch, target: Target): Promise<Attributes> {
  const adopted = {
    name: target.name,
    readReplication: { mode: target.readReplication },
    jurisdiction: "default",
  };
  const exit = await withProvider(fetch, (provider) =>
    provider.read!({ id: "Db", olds: adopted, output: undefined } as never),
  );
  return value(exit) as Attributes;
}

const diffOf = async (fetch: typeof globalThis.fetch, news: object, output: Attributes) =>
  value(
    await withProvider(fetch, (provider) =>
      provider.diff!({ id: "Db", olds: news, news, output } as never),
    ),
  );

/** One run of the stack job's migrate step: the provider's reconcile, which `--force` runs every release. */
const reconcile = (fetch: typeof globalThis.fetch, news: object, output: Attributes) =>
  withProvider(
    fetch,
    (provider) =>
      provider.reconcile({ id: "Db", olds: news, news, output } as never) as Effect.Effect<
        Attributes,
        unknown,
        unknown
      >,
  );

/** The SQL texts that write: every one sent but a read. */
const writes = (sent: readonly string[]) =>
  sent.filter((sql) => !/^\s*(?:PRAGMA table_info|SELECT )/.test(sql));

/** The live read's counts over the database, and what the plan guard makes of them. */
async function counted(DB: LocalD1, target: Target) {
  const ledger = await readLedger(
    async (sql) => (await DB.prepare(sql).all()).results as LedgerRow[],
    migrationFiles(target.sources, target.stack),
  );
  return { ledger, judged: judgeLedger(target.name, ledger) };
}

/** A database converted by the migrate step, ready for what comes after. */
async function converted(label: string, target: Target = ZAP) {
  const db = copyOfHistory(target, label);
  const local = await open(db);
  const { DB } = local.env;
  const migrations = flattened(target, join(db.dir, "stack"));
  const news = productionProps(target, migrations);
  const api = cloudflare(DB, target);
  const state = value(await reconcile(api.fetch, news, await adoptedState(api.fetch, target)));
  return { db, local, DB, migrations, news, state };
}

beforeAll(async () => {
  if (!TIER) return;
  wrangler = (await import(
    /* @vite-ignore */ createRequire(join(CIRE_API, "package.json")).resolve("wrangler")
  )) as WranglerModule;
  root = mkdtempSync(join(tmpdir(), "ledger-conversion-"));
});

afterAll(() => {
  if (!TIER) return;
  mkdirSync(join(PACKAGE, "d1-artifacts"), { recursive: true });
  writeFileSync(
    join(PACKAGE, "d1-artifacts", "ledger-conversion.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  rmSync(root, { recursive: true, force: true });
});

const PROBE = "29991231235959_conversion_probe.sql";
const PROBE_SQL =
  "CREATE TABLE conversion_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL);\n" +
  "--> statement-breakpoint\n" +
  "INSERT INTO conversion_probe (note) VALUES ('applied once');\n";

describe.skipIf(!TIER)(
  "each production database moves from Wrangler's migrator to Alchemy's",
  () => {
    for (const target of TARGETS) {
      test(`C1 ${target.name}: the move applies nothing Wrangler applied and freezes its ledger; a new migration then applies once; a Wrangler run after it applies nothing`, async () => {
        const db = copyOfHistory(target, "move");
        const local = await open(db);
        const { DB } = local.env;
        let wranglerLedger: string[] = [];
        try {
          // Rows no migration owns, which nothing may touch.
          await DB.prepare(
            "CREATE TABLE conversion_sentinel (id INTEGER PRIMARY KEY, note TEXT NOT NULL)",
          ).run();
          await DB.prepare("INSERT INTO conversion_sentinel (note) VALUES ('kept')").run();
          wranglerLedger = await names(DB, "d1_migrations");
          record(target, "wranglerRows", wranglerLedger.length);
          const before = await snapshot(DB);

          // The release check on the ledger Wrangler left: nothing refused, the freeze to apply.
          const pre = await counted(DB, target);
          record(target, "countsBeforeTheMove", pre.ledger);
          expect(pre.ledger).toEqual({
            table: "d1_migrations",
            foreign: 0,
            frozen: false,
            rows: wranglerLedger.length,
            duplicates: 0,
            matched: wranglerLedger.length,
            unmatched: 0,
            rewritten: 0,
            pending: 1,
            skipped: 0,
            late: 0,
            wranglerRows: wranglerLedger.length,
            frozenMissing: 0,
          } satisfies LedgerCounts);
          expect(pre.judged.refusals).toEqual([]);

          const migrations = flattened(target, join(db.dir, "stack"));
          const news = productionProps(target, migrations);
          const api = cloudflare(DB, target);
          const adopted = await adoptedState(api.fetch, target);
          expect(adopted.migrationsTable).toBeUndefined();
          expect(adopted.migrationsHashes).toEqual({});
          // The plan: the adopted database, now with migrations, is an update.
          expect(await diffOf(api.fetch, news, adopted)).toEqual({ action: "update" });

          api.sent.length = 0;
          const moved = value(await reconcile(api.fetch, news, adopted));
          const sent = writes(api.sent);
          record(target, "writesOfTheMove", sent);
          // Two writes: the ledger's conversion, and the freeze. No migration Wrangler applied.
          expect(sent).toHaveLength(2);
          const [conversion = "", freeze] = sent;
          expect(conversion).toMatch(/^CREATE TABLE IF NOT EXISTS "__alchemy_migrations" \(/);
          const inserts = conversion.split("\n").filter((line) => line.startsWith("INSERT"));
          expect(inserts).toHaveLength(wranglerLedger.length);
          for (const line of inserts) expect(line).toMatch(/^INSERT INTO "__alchemy_migrations" /);
          expect(freeze).toBe(
            `${FREEZE_MIGRATION.sql.trim()}\nINSERT INTO "__alchemy_migrations" (hash, created_at, name, applied_at) VALUES ('${moved.migrationsHashes[FREEZE_MIGRATION.name]}', NULL, '${FREEZE_MIGRATION.name}', datetime('now'));`,
          );
          expect(moved.migrationsTable).toBe("__alchemy_migrations");

          // No row moved, no object changed, Wrangler's ledger is as it was.
          const after = await snapshot(DB);
          expect(withoutAlchemy(after)).toEqual(before);
          expect(await names(DB, "__alchemy_migrations")).toEqual([
            ...wranglerLedger,
            FREEZE_MIGRATION.name,
          ]);
          expect(await names(DB, "d1_migrations")).toEqual(wranglerLedger);

          const post = await counted(DB, target);
          record(target, "countsAfterTheMove", post.ledger);
          expect(post.ledger).toMatchObject({
            table: "__alchemy_migrations",
            rows: wranglerLedger.length + 1,
            unmatched: 0,
            rewritten: 0,
            pending: 0,
            skipped: 0,
            frozen: true,
            frozenMissing: 0,
          } satisfies Partial<LedgerCounts>);
          expect(post.judged.refusals).toEqual([]);

          // A new migration: an update in the plan, applied once, then nothing.
          writeFileSync(join(migrations, PROBE), PROBE_SQL);
          expect(await diffOf(api.fetch, news, moved)).toEqual({ action: "update" });
          api.sent.length = 0;
          const migrated = value(await reconcile(api.fetch, news, moved));
          record(target, "writesOfANewMigration", writes(api.sent));
          expect(writes(api.sent)).toEqual([
            "CREATE TABLE conversion_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL);\n" +
              "INSERT INTO conversion_probe (note) VALUES ('applied once');\n" +
              `INSERT INTO "__alchemy_migrations" (hash, created_at, name, applied_at) VALUES ('${migrated.migrationsHashes[PROBE]}', ${Date.UTC(2999, 11, 31, 23, 59, 59)}, '${PROBE}', datetime('now'));`,
          ]);
          api.sent.length = 0;
          value(await reconcile(api.fetch, news, migrated));
          expect(writes(api.sent)).toEqual([]);
          expect(await rows(DB, "SELECT note FROM conversion_probe")).toEqual([
            { note: "applied once" },
          ]);
        } finally {
          await local.dispose();
        }

        // Wrangler from an older checkout, whose directory holds a file the
        // frozen ledger lacks, applies nothing: its ledger INSERT fails and the
        // whole migration rolls back.
        const stale = join(db.dir, "older-checkout");
        mkdirSync(stale);
        for (const file of migrationFiles({ source: target.history.at(-1)! })) {
          writeFileSync(join(stale, file.name), file.sql);
        }
        writeFileSync(
          join(stale, "29991231235958_replay_probe.sql"),
          "CREATE TABLE replay_probe (id INTEGER);\n",
        );
        const replay = wranglerApply(db, stale);
        record(target, "wranglerAfterTheFreeze", { exitCode: replay.exitCode });
        expect(replay.exitCode).not.toBe(0);
        expect(replay.output).toContain("d1_migrations is frozen");
        const reopened = await open(db);
        try {
          expect(
            await rows(
              reopened.env.DB,
              "SELECT name FROM sqlite_master WHERE name = 'replay_probe'",
            ),
          ).toEqual([]);
          expect(await names(reopened.env.DB, "d1_migrations")).toEqual(wranglerLedger);
        } finally {
          await reopened.dispose();
        }
      });
    }

    test("C2 cire-db: without the archive's names, Alchemy refuses the ledger before it writes anything", async () => {
      const db = copyOfHistory(CIRE, "no-archive");
      const local = await open(db);
      try {
        const { DB } = local.env;
        const before = await snapshot(DB);
        const migrations = flattened(CIRE, join(db.dir, "stack"), {
          source: CIRE.sources.source,
          freeze: true,
        });
        const api = cloudflare(DB, CIRE);
        const exit = await reconcile(
          api.fetch,
          productionProps(CIRE, migrations),
          await adoptedState(api.fetch, CIRE),
        );
        const refusal = failure(exit);
        record(CIRE, "withoutTheArchive", {
          refusal: refusal.split(":")[0],
          writes: writes(api.sent),
        });
        expect(refusal).toContain("MigrationHistoryConflictError");
        expect(refusal).toContain("80 recorded migration(s) match no local file");
        expect(writes(api.sent)).toEqual([]);
        expect(await snapshot(DB)).toEqual(before);
      } finally {
        await local.dispose();
      }
    });

    test("C3 cire-db: a ledger missing one archived migration is refused by the release check, and Alchemy refuses its placeholder rather than record it", async () => {
      const db = copyOfHistory(CIRE, "archive-gap");
      const local = await open(db);
      try {
        const { DB } = local.env;
        await DB.prepare("DELETE FROM d1_migrations WHERE name = '0040_vendors.sql'").run();
        const { ledger, judged } = await counted(DB, CIRE);
        record(CIRE, "countsWithAnArchiveGap", ledger);
        expect(ledger).toMatchObject({ skipped: 1, unmatched: 0 });
        expect(judged.refusals.join("\n")).toContain(
          "1 migration file of cire-db is missing from its ledger",
        );
        // What the guard stops: Alchemy would run the placeholder, which fails
        // before its ledger row is written, and never the archived SQL.
        const before = withoutAlchemy(await snapshot(DB));
        const migrations = flattened(CIRE, join(db.dir, "stack"));
        const api = cloudflare(DB, CIRE);
        const exit = await reconcile(
          api.fetch,
          productionProps(CIRE, migrations),
          await adoptedState(api.fetch, CIRE),
        );
        expect(failure(exit)).toContain("0040_vendors.sql was never applied to this database");
        expect(withoutAlchemy(await snapshot(DB))).toEqual(before);
        expect(await names(DB, "__alchemy_migrations")).not.toContain("0040_vendors.sql");
      } finally {
        await local.dispose();
      }
    });

    test("C4 zap-db-prod: a first contact that cannot read Wrangler's ledger changes no data and leaves the mark the release check refuses", async () => {
      const db = copyOfHistory(ZAP, "unread-ledger");
      const local = await open(db);
      try {
        const { DB } = local.env;
        const before = await snapshot(DB);
        const migrations = flattened(ZAP, join(db.dir, "stack"));
        const api = cloudflare(DB, ZAP, (sql) =>
          sql === 'PRAGMA table_info("d1_migrations");' ? "refuse" : "run",
        );
        const exit = await reconcile(
          api.fetch,
          productionProps(ZAP, migrations),
          await adoptedState(api.fetch, ZAP),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(withoutAlchemy(await snapshot(DB))).toEqual(before);
        const { ledger, judged } = await counted(DB, ZAP);
        record(ZAP, "countsAfterAnUnreadLedger", ledger);
        expect(ledger).toMatchObject({ table: "__alchemy_migrations", rows: 0, wranglerRows: 4 });
        expect(judged.refusals.join("\n")).toContain(
          "zap-db-prod's __alchemy_migrations is empty beside 4 rows of d1_migrations",
        );
      } finally {
        await local.dispose();
      }
    });

    test("C5 zap-db-prod: a migration that fails part-way leaves no table and no ledger row", async () => {
      const moved = await converted("failing-migration");
      try {
        writeFileSync(
          join(moved.migrations, "29991231235957_failing_probe.sql"),
          "CREATE TABLE failing_probe (id INTEGER);\n--> statement-breakpoint\nINSERT INTO no_such_table VALUES (1);\n",
        );
        const api = cloudflare(moved.DB, ZAP);
        expect(Exit.isFailure(await reconcile(api.fetch, moved.news, moved.state))).toBe(true);
        expect(
          await rows(moved.DB, "SELECT name FROM sqlite_master WHERE name = 'failing_probe'"),
        ).toEqual([]);
        expect(await names(moved.DB, "__alchemy_migrations")).not.toContain(
          "29991231235957_failing_probe.sql",
        );
      } finally {
        await moved.local.dispose();
      }
    });

    test("C6 zap-db-prod: a reply lost after the migration landed is not sent again; one that never arrived is, once", async () => {
      const moved = await converted("lost-replies");
      try {
        writeFileSync(
          join(moved.migrations, "29991231235956_lost_reply_probe.sql"),
          "CREATE TABLE lost_reply_probe (id INTEGER);\n--> statement-breakpoint\nINSERT INTO lost_reply_probe VALUES (1);\n",
        );
        const lost = new Set<string>();
        const lostReply = cloudflare(moved.DB, ZAP, (sql) => {
          if (!sql.includes("CREATE TABLE lost_reply_probe") || lost.has("lost")) return "run";
          lost.add("lost");
          return "lose-reply";
        });
        const afterLost = value(await reconcile(lostReply.fetch, moved.news, moved.state));
        expect(
          lostReply.sent.filter((sql) => sql.includes("CREATE TABLE lost_reply_probe")),
        ).toHaveLength(1);
        expect(await rows(moved.DB, "SELECT count(*) AS n FROM lost_reply_probe")).toEqual([
          { n: 1 },
        ]);

        writeFileSync(
          join(moved.migrations, "29991231235955_retry_probe.sql"),
          "CREATE TABLE retry_probe (id INTEGER);\n--> statement-breakpoint\nINSERT INTO retry_probe VALUES (1);\n",
        );
        const busy = new Set<string>();
        const failedBefore = cloudflare(moved.DB, ZAP, (sql) => {
          if (!sql.includes("CREATE TABLE retry_probe") || busy.has("busy")) return "run";
          busy.add("busy");
          return "fail-before";
        });
        value(await reconcile(failedBefore.fetch, moved.news, afterLost));
        expect(
          failedBefore.sent.filter((sql) => sql.includes("CREATE TABLE retry_probe")),
        ).toHaveLength(2);
        expect(await rows(moved.DB, "SELECT count(*) AS n FROM retry_probe")).toEqual([{ n: 1 }]);
      } finally {
        await moved.local.dispose();
      }
    });

    test("C7 zap-db-prod: a conversion whose reply was lost fails that release; the next converts nothing twice", async () => {
      const db = copyOfHistory(ZAP, "lost-conversion");
      const local = await open(db);
      try {
        const { DB } = local.env;
        const wranglerLedger = await names(DB, "d1_migrations");
        const migrations = flattened(ZAP, join(db.dir, "stack"));
        const news = productionProps(ZAP, migrations);
        let lose = true;
        const first = cloudflare(DB, ZAP, (sql) => {
          if (!lose || !sql.startsWith('CREATE TABLE IF NOT EXISTS "__alchemy_migrations"'))
            return "run";
          lose = false;
          return "lose-reply";
        });
        const adopted = await adoptedState(first.fetch, ZAP);
        expect(Exit.isFailure(await reconcile(first.fetch, news, adopted))).toBe(true);
        const again = cloudflare(DB, ZAP);
        value(await reconcile(again.fetch, news, adopted));
        expect(await names(DB, "__alchemy_migrations")).toEqual([
          ...wranglerLedger,
          FREEZE_MIGRATION.name,
        ]);
        expect((await counted(DB, ZAP)).judged.refusals).toEqual([]);
      } finally {
        await local.dispose();
      }
    });

    test("C8: each production database's Wrangler config names no migrations directory, so Wrangler's migrator stops before it reads a ledger; cire's top-level block still migrates local databases", () => {
      const persist = join(root, "routes");
      for (const [config, database] of [
        ["cire/api/wrangler.toml", "cire-db"],
        ["osn/api/wrangler.toml", "osn-db-prod"],
        ["zap/api/wrangler.toml", "zap-db-prod"],
      ] as const) {
        const refused = wranglerRun([
          "d1",
          "migrations",
          "apply",
          database,
          "--env",
          "production",
          "--local",
          "--persist-to",
          persist,
          "--config",
          join(REPO, config),
        ]);
        expect({ config, exitCode: refused.exitCode }).toEqual({ config, exitCode: 1 });
        expect(refused.output).toContain("No migrations present");
      }
      const local = wranglerRun([
        "d1",
        "migrations",
        "list",
        "cire-db",
        "--local",
        "--persist-to",
        persist,
      ]);
      expect(local.exitCode).toBe(0);
      expect(local.output).toContain("0001_initial.sql");
    });
  },
);
