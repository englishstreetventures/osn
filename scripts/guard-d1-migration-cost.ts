/**
 * Guard the D1 cost of building a database from its migration chain.
 *
 * Replays every `.sql` in the chain into in-memory `bun:sqlite` and counts
 * SCHEMA WRITES — one per schema-changing statement, two for an `ALTER TABLE
 * ... DROP COLUMN` table rebuild — then prices them at
 * {@link ROWS_WRITTEN_PER_SCHEMA_WRITE}. Rows a data statement in a migration
 * actually writes are counted exactly, from SQLite's own `changes`. No D1 call.
 *
 * The schema-write count is exact. Every ROW figure the guard prints carries a
 * 22-27 band and is pessimistic by up to about a fifth, which is why the line
 * the guard enforces is printed in schema writes beside the budget — the
 * threshold can be read without trusting the constant at all.
 *
 * @see wiki/conventions/bundle-size-guards.md — the budgets file, and the two
 * rules any threshold obeys.
 * @see wiki/decisions/d1-migration-cost-budget-calibration.md — how the
 * constant was calibrated, and what is not in it (the seed, the ledger insert,
 * the read ceiling).
 *
 * Usage:
 *   guard-d1-migration-cost.ts --all              every row in the budgets
 *                                                 file. What ci.yml calls.
 *   guard-d1-migration-cost.ts <migrations-dir>   one chain, matched to its
 *                                                 row by repo-relative path.
 *
 * D1_MIGRATION_COST_BUDGETS_FILE overrides the budgets file path, and
 * D1_MIGRATION_COST_BUDGETS_ROOT the root each row's path resolves against
 * (the repo root in real use; a fixture tree in the tests).
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Rows written on D1 per schema write. The evidence puts it somewhere around
 * 22 to 27, and 27 is the top of it, which is the safe side. Changing it
 * changes every printed row figure and every headroom figure, so it is a
 * re-baseline of the same weight as a budget row.
 *
 * @see wiki/decisions/d1-migration-cost-budget-calibration.md — both anchors,
 * and why the band is that wide.
 */
export const ROWS_WRITTEN_PER_SCHEMA_WRITE = 27;

/**
 * Cloudflare D1 Free, rows written per day, shared across every database on
 * the account. wiki/shared/free-tier-limits.md is the source and says to
 * re-verify it against Cloudflare's own pricing page before acting on it.
 */
export const DAILY_ROWS_WRITTEN_CEILING = 100_000;

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

export type ChainCost = {
  readonly files: number;
  readonly statements: number;
  /** Schema statements, with a table-rebuilding one counted twice. */
  readonly schemaWrites: number;
  /** Statements that rebuild a table, for the reader — not a separate charge. */
  readonly tableRebuilds: number;
  /** Rows a data statement in a migration really wrote, from SQLite. */
  readonly dataRows: number;
  readonly estimatedRowsWritten: number;
};

export type BudgetRecord = {
  readonly chain: string;
  readonly budget: number;
};

/**
 * Split a Drizzle migration file into single statements.
 *
 * Drizzle writes `--> statement-breakpoint` between statements, but not
 * between every pair of them — the archived cire chain held 283 statements
 * behind 222 breakpoints — so `;` has to be a separator too. Splitting on a
 * bare `;` would cut a statement in half the moment a column default or a
 * `CHECK` held one, so this walks the text: single-quoted strings (with `''`
 * escapes), the three identifier quotings SQLite accepts, line comments,
 * block comments, and a trigger's `BEGIN ... END;` body all swallow their
 * semicolons.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  let triggerDepth = 0;

  const flush = () => {
    const trimmed = stripComments(current).trim();
    if (trimmed.length > 0) statements.push(trimmed);
    current = "";
  };

  /** Whether what has accumulated so far opens a body ended by `END`. */
  const opensTriggerBody = () =>
    /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(stripComments(current));

  while (index < sql.length) {
    const char = sql[index]!;
    const rest = sql.slice(index);

    if (char === "'" || char === '"' || char === "`") {
      const end = closingQuote(sql, index, char);
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "[") {
      const end = sql.indexOf("]", index + 1);
      const stop = end === -1 ? sql.length : end + 1;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (rest.startsWith("--")) {
      const lineEnd = sql.indexOf("\n", index);
      const stop = lineEnd === -1 ? sql.length : lineEnd;
      const comment = sql.slice(index, stop);
      // The breakpoint marker is written as a comment, so it has to be
      // recognised here rather than after comments are stripped.
      if (/^-->\s*statement-breakpoint/.test(comment)) {
        flush();
        triggerDepth = 0;
      } else {
        current += comment;
      }
      index = stop;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (/^BEGIN\b/i.test(rest) && (triggerDepth > 0 || opensTriggerBody())) {
      triggerDepth += 1;
      current += rest.slice(0, 5);
      index += 5;
      continue;
    }
    if (triggerDepth > 0 && /^END\b/i.test(rest)) {
      triggerDepth -= 1;
      current += rest.slice(0, 3);
      index += 3;
      continue;
    }
    if (char === ";" && triggerDepth === 0) {
      flush();
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  flush();
  return statements;
}

/** Index just past the closing quote of the run starting at `open`. */
function closingQuote(sql: string, open: number, quote: string): number {
  let index = open + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      // A doubled quote is an escaped one and the run continues.
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function stripComments(sql: string): string {
  return sql
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      const at = indexOfUnquoted(line, "--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** Where `needle` first sits outside any quoted run of `line`. */
function indexOfUnquoted(line: string, needle: string): number {
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === "'" || char === '"' || char === "`") {
      index = closingQuote(line, index, char);
      continue;
    }
    if (line.startsWith(needle, index)) return index;
    index += 1;
  }
  return -1;
}

const SCHEMA_STATEMENT = /^(?:CREATE|DROP|ALTER)\b/i;
/**
 * `ALTER TABLE <name> DROP [COLUMN] <name>`. SQLite implements this by
 * rebuilding the table, which is the statement D1 bills at about twice an
 * ordinary schema write. Anchored on the two names either side of `DROP` so a
 * column default that merely contains the word does not match.
 */
const TABLE_REBUILD = /^ALTER\s+TABLE\s+\S+\s+DROP\s+(?:COLUMN\s+)?\S/i;
/**
 * Drizzle's other table rebuild: copy into `__new_x`, drop `x`, rename. Each
 * of its statements already costs a schema write of its own, so this only
 * counts them for the reader.
 */
const REBUILD_SCRATCH_TABLE = /\b__(?:new|keep)_/i;

/** One statement's contribution, ready to sum. */
type Charge = {
  readonly schemaWrites: number;
  readonly rebuild: boolean;
};

function chargeFor(statement: string): Charge {
  const normalised = statement.replaceAll(/\s+/g, " ").trim();
  if (!SCHEMA_STATEMENT.test(normalised)) return { schemaWrites: 0, rebuild: false };
  if (TABLE_REBUILD.test(normalised)) return { schemaWrites: 2, rebuild: true };
  return { schemaWrites: 1, rebuild: REBUILD_SCRATCH_TABLE.test(normalised) };
}

/**
 * Replay a chain into an in-memory database and total what a from-zero
 * rebuild of it costs. Throws when a statement does not apply: a chain that
 * cannot build is a failure, not a cheap chain.
 */
export function measureChain(dir: string): ChainCost {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`${dir} holds no .sql migrations — nothing was measured, which is not a pass.`);
  }

  const db = new Database(":memory:");
  try {
    // Off for the same reason `wrangler d1 migrations apply` gets away with
    // the rebuild idiom: a chain that drops and recreates a parent table
    // would otherwise fail on its children mid-replay.
    db.run("PRAGMA foreign_keys=OFF");

    let statements = 0;
    let schemaWrites = 0;
    let tableRebuilds = 0;
    let dataRows = 0;

    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      for (const statement of splitSqlStatements(sql)) {
        let changes = 0;
        try {
          changes = Number(db.run(statement).changes ?? 0);
        } catch (cause) {
          throw new Error(
            `${file} failed to apply: ${String(cause)}\n  statement: ${statement.slice(0, 200)}`,
            { cause },
          );
        }
        statements += 1;
        const charge = chargeFor(statement);
        schemaWrites += charge.schemaWrites;
        if (charge.rebuild) tableRebuilds += 1;
        if (charge.schemaWrites === 0) dataRows += changes;
      }
    }

    return {
      files: files.length,
      statements,
      schemaWrites,
      tableRebuilds,
      dataRows,
      estimatedRowsWritten: schemaWrites * ROWS_WRITTEN_PER_SCHEMA_WRITE + dataRows,
    };
  } finally {
    db.close();
  }
}

/** How many from-zero rebuilds of this cost fit in one day's allowance. */
export function rebuildsPerDay(rowsWritten: number): number {
  if (rowsWritten <= 0) return DAILY_ROWS_WRITTEN_CEILING;
  return Math.floor(DAILY_ROWS_WRITTEN_CEILING / rowsWritten);
}

/**
 * Parse the budgets file. Fails closed on any malformed row rather than
 * skipping it — one bad edit should not quietly stop guarding every chain
 * after it.
 */
export function parseBudgets(contents: string, label: string): readonly BudgetRecord[] {
  const records: BudgetRecord[] = [];
  const lines = contents.split("\n");

  for (const [offset, line] of lines.entries()) {
    const stripped = line.split("#")[0]!.trim();
    if (stripped.length === 0) continue;
    const fields = stripped.split(/\s+/);
    const [chain, budget, ...extra] = fields;
    if (chain === undefined || budget === undefined || extra.length > 0) {
      throw new Error(
        `${label}:${offset + 1}: expected '<migrations-dir> <budget-rows-written>', got '${stripped}'`,
      );
    }
    if (!/^\d+$/.test(budget)) {
      throw new Error(`${label}:${offset + 1}: budget must be a positive integer, got '${budget}'`);
    }
    records.push({ chain, budget: Number(budget) });
  }

  if (records.length === 0) {
    throw new Error(`${label} has no records — nothing to guard, which is a broken config.`);
  }
  return records;
}

function percentOfCeiling(rows: number): string {
  return `${((rows / DAILY_ROWS_WRITTEN_CEILING) * 100).toFixed(1)}%`;
}

/**
 * The budget restated in the unit the guard counts exactly: the largest whole
 * number of schema writes that still fits, once the chain's real data rows are
 * taken off the top.
 */
function budgetInSchemaWrites(budget: number, dataRows: number): number {
  return Math.max(0, Math.floor((budget - dataRows) / ROWS_WRITTEN_PER_SCHEMA_WRITE));
}

/** Runs one record. Returns true when the chain is inside its budget. */
export function runGuard(chain: string, dir: string, budget: number, budgetsPath: string): boolean {
  const cost = measureChain(dir);
  const rows = cost.estimatedRowsWritten;
  const affordable = rebuildsPerDay(rows);

  console.log(
    `${chain}: ${cost.files} migration file(s), ${cost.statements} statements, ` +
      `${cost.schemaWrites} schema writes, ${cost.tableRebuilds} table-rebuild statement(s)`,
  );
  console.log(
    `  replaying the chain from zero costs about ${rows} D1 rows written ` +
      `(${percentOfCeiling(rows)} of the ${DAILY_ROWS_WRITTEN_CEILING}/day free-tier ceiling)`,
  );
  console.log(
    `  that affords roughly ${affordable} replay(s) a day, before the seed a full rebuild adds`,
  );
  console.log(
    `  budget ${budget} rows written (${rebuildsPerDay(budget)} a day), ` +
      `${budget - rows} rows of headroom`,
  );
  // Every row figure above is priced by a constant the evidence only pins to
  // about 22-27 (see the file header). This line is the same threshold in the
  // unit the guard counts exactly, so it can be read without that constant.
  console.log(
    `  exactly: ${cost.schemaWrites} schema writes against a line at ` +
      `${budgetInSchemaWrites(budget, cost.dataRows)}`,
  );

  if (rows > budget) {
    console.error(
      `::error::${chain} is ${cost.schemaWrites} schema writes, over the line at ` +
        `${budgetInSchemaWrites(budget, cost.dataRows)}. That is about ${rows} D1 rows written to ` +
        `replay from zero, over the ${budget} row budget in ${budgetsPath}, and affords roughly ` +
        `${affordable} replays a day against the ${DAILY_ROWS_WRITTEN_CEILING} rows/day ` +
        `free-tier ceiling, down from ${rebuildsPerDay(budget)} at the budget. The chain has ` +
        `grown, which is what this guard watches: squash it into a fresh baseline the way ` +
        `englishstventures/osn#984 did, or raise the budget deliberately with the reason in the commit.`,
    );
    return false;
  }
  return true;
}

type LoadedBudgets = {
  readonly path: string;
  readonly records: readonly BudgetRecord[];
};

function resolveBudgetsPath(): string {
  return (
    process.env.D1_MIGRATION_COST_BUDGETS_FILE ?? join(SCRIPT_DIR, "d1-migration-cost-budgets.txt")
  );
}

function budgetsRoot(): string {
  return process.env.D1_MIGRATION_COST_BUDGETS_ROOT ?? REPO_ROOT;
}

function loadBudgets(): LoadedBudgets {
  const path = resolveBudgetsPath();
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`budgets file not found: ${path}`, { cause });
  }
  return { path, records: parseBudgets(contents, path) };
}

function main(argv: readonly string[]): number {
  if (argv.length !== 1) {
    console.error(
      "::error::usage: guard-d1-migration-cost.ts --all | guard-d1-migration-cost.ts <migrations-dir>",
    );
    return 1;
  }

  let path: string;
  let records: readonly BudgetRecord[];
  try {
    ({ path, records } = loadBudgets());
  } catch (cause) {
    console.error(
      `::error::guard-d1-migration-cost.ts: ${String(cause instanceof Error ? cause.message : cause)}`,
    );
    return 1;
  }

  const root = budgetsRoot();
  const target = argv[0]!;
  const selected =
    target === "--all"
      ? records
      : records.filter((record) => resolve(root, record.chain) === resolve(target));

  if (selected.length === 0) {
    console.error(
      `::error::guard-d1-migration-cost.ts: no budget recorded for '${target}' in ${path} — ` +
        `add a row before wiring this chain to the guard.`,
    );
    return 1;
  }

  // Every record runs even after one fails, so a run reports every chain over
  // budget in one pass instead of stopping at the first.
  let failed = false;
  for (const record of selected) {
    const dir = resolve(root, record.chain);
    try {
      if (!statSync(dir).isDirectory()) throw new Error("not a directory");
    } catch {
      console.error(
        `::error::guard-d1-migration-cost.ts: migrations directory '${dir}' does not exist.`,
      );
      failed = true;
      continue;
    }
    try {
      if (!runGuard(record.chain, dir, record.budget, path)) failed = true;
    } catch (cause) {
      console.error(
        `::error::${record.chain}: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
      failed = true;
    }
  }

  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
