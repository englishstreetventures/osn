#!/usr/bin/env bun
/**
 * Apply cire D1 migrations to one database, after checking its ledger.
 *
 * `cire/db/migrations/0001_initial.sql` is a baseline that builds what every
 * file in `cire/db/migrations-archive/` builds. It keeps the name
 * `0001_initial.sql` because every deployed ledger holds that name, so
 * `wrangler d1 migrations apply` skips it there and applies only what comes
 * after it. That skip is right only on a database that had applied the whole
 * archived chain, or was built from this baseline. On one that stopped
 * part-way, wrangler would skip the baseline and never run the rest of the
 * archive either, and nothing would say so until a query hit a missing column.
 *
 * So this reads the target's schema and `d1_migrations` ledger first and
 * refuses that case (`checkLedger`, then `checkBaselineSchema` for a ledger
 * holding only the baseline's name), then runs `wrangler d1 migrations apply`
 * with the same arguments. cire/db's `db:push` and `db:migrate:*` scripts call
 * it, and through them deploy.yml and cire-dev-db-rebuild.yml.
 *
 * Usage, as cire/db's package scripts call it:
 *   cire-db-migrate.ts cire-db --local
 *   cire-db-migrate.ts cire-db-dev --env dev --remote
 *   cire-db-migrate.ts cire-db --env production --remote
 * Everything after the database name goes to wrangler unchanged, for the ledger
 * read and the apply alike, so the two can never target different databases.
 *
 * Wrangler is the binary cire/api installs from the lockfile — the version that
 * deploys the Worker — run with cire/api as its working directory, so a
 * relative `--persist-to` resolves from there. When cire/api has no wrangler of
 * its own this stops rather than fetch one from the registry. The ledger read
 * is not interactive, so a person running a remote script needs a wrangler
 * login that names one account, or CLOUDFLARE_ACCOUNT_ID set.
 *
 * Everything but the `import.meta.main` block is pure; that block is the only
 * part that spawns wrangler or sets the exit code.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CIRE_API_DIR = resolve(REPO_ROOT, "cire/api");
const WRANGLER = resolve(CIRE_API_DIR, "node_modules/.bin/wrangler");
const WRANGLER_CONFIG = resolve(CIRE_API_DIR, "wrangler.toml");
export const MIGRATIONS_DIR = resolve(REPO_ROOT, "cire/db/migrations");
export const ARCHIVE_DIR = resolve(REPO_ROOT, "cire/db/migrations-archive");

/** The baseline's filename, which every deployed ledger already holds. */
export const BASELINE = "0001_initial.sql";

/** The ledger table wrangler writes; cire/api/wrangler.toml sets no other. */
export const LEDGER_TABLE = "d1_migrations";

/**
 * The archived migration each chain this repository built ran first after its
 * `0001_initial.sql`: the original chain, then each earlier baseline's first
 * follow-on. A ledger whose archived entries begin anywhere else lacks the
 * migrations before them. A squash appends the first live migration after the
 * baseline before archiving it.
 */
export const CHAIN_STARTS: readonly string[] = [
  "0002_add_rsvp_dietary.sql",
  "0058_gift_summary_and_stripe_state.sql",
];

/** A ledger read that takes longer than this has stalled; it fails, and nothing is applied. */
const QUERY_TIMEOUT_MS = 120_000;

/**
 * How to bring a refused database level without breaking what serves it. A
 * missing archived migration can change schema an older Worker still reads, so
 * it is never applied by hand to a database that Worker is serving.
 */
const RECOVERY =
  "Production: approve the deploy run of a commit from before the archive took " +
  "these files, let it finish — it applies them and deploys the code that matches — " +
  "then re-run this one. Dev: run cire-dev-db-rebuild.yml. Local: " +
  "`bun run --cwd cire/db db:reset`.";

/** The archived chain, in the name order wrangler applied it. */
export function archivedMigrations(dir: string = ARCHIVE_DIR): readonly string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
}

/** A migration's leading number, or NaN for a name that has none. */
const numberOf = (name: string): number => {
  const match = /^(\d+)_/.exec(name);
  return match ? Number(match[1]) : Number.NaN;
};

export type LedgerVerdict =
  | { readonly ok: true; readonly message: string; readonly baselineOnly: boolean }
  | { readonly ok: false; readonly missing: readonly string[]; readonly message: string };

/**
 * Whether wrangler may apply the live chain to a database whose ledger is
 * `ledger` (`null` when the database has no ledger table at all).
 *
 * - No ledger, or an empty one: a fresh database. Wrangler applies the
 *   baseline and everything after it.
 * - A ledger without the baseline's name: not a ledger this repository
 *   produced. Refused.
 * - An entry that is not an archived migration yet is numbered within the
 *   archive's range: a migration no chain here holds ran there. Refused.
 * - A ledger naming no archived migration besides the baseline: built from a
 *   baseline. Its other entries are live migrations, numbered after the
 *   archive, which wrangler tracks. When the baseline's name is its only
 *   entry, `baselineOnly` asks the caller to confirm with
 *   `checkBaselineSchema` that it was this baseline and not an older one.
 * - Otherwise the database was built from an older chain. It must hold every
 *   archived migration from the start of that chain (the last of `starts` at
 *   or before the first archived entry it holds) to the newest; a missing one
 *   is schema the baseline stands for and wrangler would never apply.
 */
export function checkLedger(
  ledger: readonly string[] | null,
  archive: readonly string[],
  starts: readonly string[] = CHAIN_STARTS,
): LedgerVerdict {
  if (ledger === null || ledger.length === 0) {
    return {
      ok: true,
      baselineOnly: false,
      message: "no migrations applied yet: a fresh database.",
    };
  }

  const held = new Set(ledger);
  if (!held.has(BASELINE)) {
    return {
      ok: false,
      missing: [BASELINE],
      message:
        `the ledger names ${ledger.length} migration(s) but not ${BASELINE}, ` +
        "so it was not built from this repository's chain. Refusing to guess.",
    };
  }

  const archived = new Set(archive);
  const newest = numberOf(archive.at(-1) ?? "");
  const strays = ledger.filter((name) => !archived.has(name) && !(numberOf(name) > newest));
  if (strays.length > 0) {
    return {
      ok: false,
      missing: strays,
      message:
        `the ledger names ${strays.join(", ")}, which no archived chain holds and which ` +
        `is not numbered after the archive's newest (${archive.at(-1) ?? "none"}), so a ` +
        "migration from outside this repository's chain ran there. Find out what it " +
        "changed before applying anything; a local database is rebuilt with " +
        "`bun run --cwd cire/db db:reset`.",
    };
  }

  const first = archive.findIndex((name) => name !== BASELINE && held.has(name));
  if (first === -1) {
    return {
      ok: true,
      baselineOnly: ledger.every((name) => name === BASELINE),
      message: `built from the baseline (${BASELINE}).`,
    };
  }

  const startsAtOrBefore = starts
    .map((name) => archive.indexOf(name))
    .filter((index) => index > 0 && index <= first);
  const from =
    startsAtOrBefore.length > 0
      ? Math.max(...startsAtOrBefore)
      : archive.findIndex((name) => name !== BASELINE);
  const missing = archive.slice(from).filter((name) => name !== BASELINE && !held.has(name));
  if (missing.length === 0) {
    return {
      ok: true,
      baselineOnly: false,
      message: `applied the archived chain from ${archive[from]} to ${archive.at(-1)}.`,
    };
  }

  return {
    ok: false,
    missing,
    message:
      `the database applied the archived chain that starts at ${archive[from]} but not ` +
      `${missing.length} migration(s) of it: ${missing.join(", ")}. The baseline ` +
      `already stands for them, so wrangler would skip them for good. ${RECOVERY}`,
  };
}

/** Case, quoting and whitespace dropped, so two spellings of one statement match. */
const normalise = (sql: string): string =>
  sql.replaceAll(/[`"]/g, "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();

/** The statements of a migration file, one per `--> statement-breakpoint`. */
export function migrationStatements(sql: string): readonly string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * For a database whose ledger holds only the baseline's name: whether its
 * schema is the one this baseline builds. Every table and index the baseline
 * creates must be stored there as written; an older baseline left different
 * tables, columns or indexes behind under the same ledger entry.
 */
export function checkBaselineSchema(
  stored: readonly string[],
  baseline: readonly string[],
): LedgerVerdict {
  const have = new Set(stored.map(normalise));
  const missing = baseline.filter((statement) => !have.has(normalise(statement)));
  if (missing.length === 0) {
    return { ok: true, baselineOnly: true, message: `built from this baseline (${BASELINE}).` };
  }
  const heads = missing.map((statement) => statement.split("(")[0]!.trim());
  return {
    ok: false,
    missing: heads,
    message:
      `the ledger holds only ${BASELINE}, but ${missing.length} of the tables and ` +
      `indexes this baseline creates are missing or differ (${heads.slice(0, 5).join("; ")}` +
      `${heads.length > 5 ? "; …" : ""}), so it was built from an older baseline. ${RECOVERY}`,
  };
}

/** The columns this script selects; one a query did not select reads as null. */
export type D1Row = { readonly name: string | null; readonly sql: string | null };

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The rows of the first result set in `wrangler d1 execute --json` output.
 * Lines wrangler prints before the JSON array are skipped; an error object, a
 * failed result or anything that is not that shape throws, quoting the text.
 */
export function parseD1Rows(stdout: string): readonly D1Row[] {
  const rows = firstResultSet(stdout);
  if (rows === undefined) {
    throw new Error(`unreadable wrangler d1 execute output: ${stdout.trim() || "(empty)"}`);
  }
  return rows;
}

/**
 * The first result set of the JSON array that starts a line of `text` and runs
 * to its end, or `undefined` when there is none or it did not succeed.
 */
function firstResultSet(text: string): readonly D1Row[] | undefined {
  const body = text.trimEnd();
  for (let at = 0; at < body.length; at = body.indexOf("\n", at) + 1 || body.length) {
    const line = body.slice(at).trimStart();
    if (!line.startsWith("[")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A line such as "[WARNING] …" opens with a bracket too; keep looking.
      continue;
    }
    const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
    if (
      typeof first !== "object" ||
      first === null ||
      !("success" in first) ||
      first.success !== true ||
      !("results" in first) ||
      !Array.isArray(first.results)
    ) {
      return undefined;
    }
    return first.results.map((row: unknown) =>
      typeof row === "object" && row !== null
        ? {
            name: "name" in row ? textOrNull(row.name) : null,
            sql: "sql" in row ? textOrNull(row.sql) : null,
          }
        : { name: null, sql: null },
    );
  }
  return undefined;
}

/**
 * Every row's name, throwing when one is unreadable: a dropped ledger entry or
 * a lost `d1_migrations` row would make a database look newer than it is.
 */
export function namesOf(rows: readonly D1Row[]): readonly string[] {
  return rows.map(({ name }) => {
    if (name === null) throw new Error("wrangler returned a row with no readable name");
    return name;
  });
}

export type Args = { readonly database: string; readonly flags: readonly string[] };

/** The database name, then wrangler's own flags, which must pick a target. */
export function parseArgs(argv: readonly string[]): Args | { readonly error: string } {
  const [database, ...flags] = argv;
  if (database === undefined || database.startsWith("-")) {
    return { error: "the first argument must be the database name, e.g. cire-db" };
  }
  const local = flags.includes("--local");
  const remote = flags.includes("--remote");
  if (local === remote) {
    return {
      error: "pass exactly one of --local or --remote, so the target is never wrangler's default",
    };
  }
  return { database, flags };
}

function query({ database, flags }: Args, sql: string): readonly D1Row[] {
  const result = Bun.spawnSync(
    [
      WRANGLER,
      "--config",
      WRANGLER_CONFIG,
      "d1",
      "execute",
      database,
      ...flags,
      "--json",
      "--command",
      sql,
    ],
    {
      cwd: CIRE_API_DIR,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: QUERY_TIMEOUT_MS,
    },
  );
  const stdout = result.stdout.toString();
  if (result.exitedDueToTimeout) {
    throw new Error(`wrangler d1 execute did not finish within ${QUERY_TIMEOUT_MS / 1000} s`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `wrangler d1 execute exited ${result.exitCode ?? result.signalCode}: ${stdout.trim()} ${result.stderr.toString().trim()}`,
    );
  }
  return parseD1Rows(stdout);
}

function applyMigrations({ database, flags }: Args): number {
  const result = Bun.spawnSync(
    [WRANGLER, "--config", WRANGLER_CONFIG, "d1", "migrations", "apply", database, ...flags],
    { cwd: CIRE_API_DIR, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  return result.exitCode ?? 1;
}

/**
 * The verdict for one database. One read of `sqlite_master` answers both
 * whether the ledger table exists and, for a baseline-only ledger, what schema
 * is stored; the ledger itself is a second read, made only when its table
 * exists, so no error is ever taken to mean "fresh".
 */
function readVerdict(args: Args): LedgerVerdict {
  const schema = query(args, "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL");
  const ledger = namesOf(schema).includes(LEDGER_TABLE)
    ? namesOf(query(args, `SELECT name FROM ${LEDGER_TABLE} ORDER BY id`))
    : null;
  const verdict = checkLedger(ledger, archivedMigrations());
  if (!verdict.ok || !verdict.baselineOnly) return verdict;
  const stored = schema.flatMap(({ sql }) => (sql === null ? [] : [sql]));
  const baseline = migrationStatements(readFileSync(resolve(MIGRATIONS_DIR, BASELINE), "utf8"));
  return checkBaselineSchema(stored, baseline);
}

/** One line to stderr, as a GitHub Actions error annotation, then exit 1. */
function fail(message: string): never {
  process.stderr.write(`::error::cire-db-migrate: ${message}\n`);
  process.exit(1);
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  if ("error" in args) fail(args.error);

  if (!existsSync(WRANGLER)) {
    fail(
      `cire/api has no wrangler of its own (${WRANGLER}), and no other version is used. ` +
        "Run `bun install --frozen-lockfile` first.",
    );
  }

  let verdict: LedgerVerdict;
  try {
    verdict = readVerdict(args);
  } catch (cause) {
    fail(`could not read the ledger of ${args.database}, so nothing was applied. ${String(cause)}`);
  }

  if (!verdict.ok) fail(`${args.database}: ${verdict.message}`);
  process.stdout.write(`cire-db-migrate: ${args.database}: ${verdict.message}\n`);
  process.exit(applyMigrations(args));
}
