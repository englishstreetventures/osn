import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BASELINE, MIGRATIONS_DIR, migrationStatements } from "../../../../scripts/cire-db-migrate";

// scripts/cire-db-migrate.ts against a real local D1, through the wrangler
// cire/api installs: the `--json` output it parses, and the schema D1 stores
// for the baseline, which its check compares with the baseline's own text.
// The script's own tests use a stand-in wrangler, so a wrangler upgrade that
// changed either would first show up here rather than as a red deploy.
//
// Two databases, because the script reads them two ways. One is built from
// nothing, so it holds the whole live chain, and the script passes it on its
// ledger alone. The other holds the baseline and nothing after it, the one
// ledger whose stored schema the script compares with the baseline's text.
//
// Each run starts wrangler and workerd, a few seconds apiece, so this runs in
// the D1 tier only: `bun run test:d1` sets CIRE_D1_TIER.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "cire-db-migrate.ts");
const CIRE_API = join(REPO_ROOT, "cire", "api");
const WRANGLER = join(CIRE_API, "node_modules", ".bin", "wrangler");

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cire-db-migrate-d1-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const target = (persist: string) => ["cire-db", "--local", "--persist-to", persist];

function migrate(persist: string): { readonly exitCode: number; readonly output: string } {
  const result = Bun.spawnSync([process.execPath, "run", SCRIPT, ...target(persist)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function execute(persist: string, sql: string): void {
  const result = Bun.spawnSync([WRANGLER, "d1", "execute", ...target(persist), "--command", sql], {
    cwd: CIRE_API,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
}

/**
 * A local `cire-db` that holds the baseline and nothing after it, built by
 * wrangler itself so its ledger is exactly what a deployed database built from
 * the baseline alone holds. Wrangler finds a local database by its id, so the
 * config it is given here names the id `cire/api/wrangler.toml` gives
 * `cire-db`, and a migrations directory holding the baseline alone.
 */
function baselineOnly(persist: string): void {
  const id = /database_name = "cire-db"\ndatabase_id = "([^"]+)"/.exec(
    readFileSync(join(CIRE_API, "wrangler.toml"), "utf8"),
  )?.[1];
  expect(id).toBeDefined();
  const dir = join(root, "baseline-only");
  mkdirSync(join(dir, "migrations"), { recursive: true });
  copyFileSync(join(MIGRATIONS_DIR, BASELINE), join(dir, "migrations", BASELINE));
  writeFileSync(
    join(dir, "wrangler.toml"),
    [
      'name = "cire-baseline-only"',
      'compatibility_date = "2025-03-01"',
      "[[d1_databases]]",
      'binding = "DB"',
      'database_name = "cire-db"',
      `database_id = "${id}"`,
      `migrations_dir = "${join(dir, "migrations")}"`,
      "",
    ].join("\n"),
  );
  const result = Bun.spawnSync(
    [
      WRANGLER,
      "d1",
      "migrations",
      "apply",
      ...target(persist),
      "--config",
      join(dir, "wrangler.toml"),
    ],
    { cwd: CIRE_API, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
}

/** The baseline's own statement for `name`, to put a dropped object back. */
function baselineStatement(name: string): string {
  const statement = migrationStatements(readFileSync(join(MIGRATIONS_DIR, BASELINE), "utf8")).find(
    (s) => s.includes(`\`${name}\``),
  );
  expect(statement).toBeDefined();
  return statement!;
}

describe.skipIf(process.env.CIRE_D1_TIER !== "1")("cire-db-migrate.ts on a local D1", () => {
  test("applies the live chain to a fresh database, passes it again, and refuses a chain stopped part-way", () => {
    const persist = join(root, "fresh");

    const fresh = migrate(persist);
    expect(fresh.output).toContain("a fresh database");
    expect(fresh.exitCode).toBe(0);

    const again = migrate(persist);
    expect(again.output).toContain(`built from the baseline (${BASELINE})`);
    expect(again.output).toContain("No migrations to apply");
    expect(again.exitCode).toBe(0);

    execute(
      persist,
      "INSERT INTO d1_migrations (name) VALUES ('0058_gift_summary_and_stripe_state.sql'), ('0080_rsvp_organiser_attribution.sql')",
    );
    const partWay = migrate(persist);
    expect(partWay.output).toContain("0059_rsvp_dietary_presets.sql");
    expect(partWay.output).toContain("0081_owner_notice_budget.sql");
    expect(partWay.exitCode).toBe(1);
  }, 60_000);

  test("checks a baseline-only database against the baseline's text before applying the rest", () => {
    const persist = join(root, "baseline");
    baselineOnly(persist);

    execute(persist, "DROP INDEX sessions_token_unique");
    const differs = migrate(persist);
    expect(differs.output).toContain("older baseline");
    expect(differs.output).toContain("sessions_token_unique");
    expect(differs.exitCode).toBe(1);

    execute(persist, baselineStatement("sessions_token_unique"));
    const same = migrate(persist);
    expect(same.output).toContain("built from this baseline");
    expect(same.exitCode).toBe(0);
  }, 60_000);
});
