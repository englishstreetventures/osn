// The `import.meta.main` block of scripts/cire-db-migrate.ts, which cire/db's
// `db:push` and `db:migrate:*` scripts run: what reaches `wrangler d1
// migrations apply`, and with what exit code.
//
// Each test copies the script byte for byte into a temporary tree shaped like
// this repository, so it finds a stand-in for cire/api's wrangler where it
// looks for the real one. The stand-in logs every call and answers from files
// the test writes. The archive and baseline in the tree are the real ones.
// The real wrangler, against a local D1, is exercised by the cire/api D1 tier.
// Every test builds its own tree, so they run concurrently.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archivedMigrations,
  BASELINE,
  migrationStatements,
  MIGRATIONS_DIR,
} from "../cire-db-migrate";

const SCRIPT = join(import.meta.dir, "..", "cire-db-migrate.ts");
const REAL_CIRE_DB = join(MIGRATIONS_DIR, "..");

let root: string;

beforeAll(() => {
  // Real path, so it matches the working directory the stand-in reports.
  root = realpathSync(mkdtempSync(join(tmpdir(), "cire-db-migrate-cli-")));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type Step = "schema" | "ledger" | "apply";
type Answer = { readonly out?: string; readonly exit?: number; readonly kill?: boolean };

/**
 * A tree holding the script, the real archive and baseline, and (unless
 * `wrangler` is false) a stand-in wrangler answering each step as given.
 */
function tree(answers: Partial<Record<Step, Answer>>, wrangler = true): string {
  const dir = mkdtempSync(join(root, "tree-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(SCRIPT, join(dir, "scripts", "cire-db-migrate.ts"));
  mkdirSync(join(dir, "cire", "db"), { recursive: true });
  symlinkSync(join(REAL_CIRE_DB, "migrations"), join(dir, "cire", "db", "migrations"));
  symlinkSync(
    join(REAL_CIRE_DB, "migrations-archive"),
    join(dir, "cire", "db", "migrations-archive"),
  );
  mkdirSync(join(dir, "cire", "api", "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "cire", "api", "wrangler.toml"), "");
  const state = join(dir, "state");
  mkdirSync(state);
  for (const [step, answer] of Object.entries(answers)) {
    writeFileSync(join(state, `${step}.out`), answer.out ?? "");
    writeFileSync(join(state, `${step}.exit`), String(answer.exit ?? 0));
    if (answer.kill) writeFileSync(join(state, `${step}.kill`), "");
  }
  if (wrangler) {
    const stub = join(dir, "cire", "api", "node_modules", ".bin", "wrangler");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
state=${JSON.stringify(state)}
printf '%s\\n' "--- call" "$PWD" "$@" >> "$state/calls.log"
case "$*" in
  *" migrations apply "*) step=apply ;;
  *"FROM sqlite_master"*) step=schema ;;
  *"FROM d1_migrations"*) step=ledger ;;
  *) exit 99 ;;
esac
[ -f "$state/$step.kill" ] && kill -9 $$
cat "$state/$step.out" 2>/dev/null
exit "$(cat "$state/$step.exit" 2>/dev/null || echo 0)"
`,
    );
    chmodSync(stub, 0o755);
  }
  return dir;
}

/** Each call the stand-in received: its working directory, then its arguments. */
function calls(dir: string): Array<{ readonly cwd: string; readonly args: readonly string[] }> {
  const log = join(dir, "state", "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("--- call\n")
    .filter(Boolean)
    .map((call) => {
      const [cwd, ...args] = call.trimEnd().split("\n");
      return { cwd: cwd!, args };
    });
}

const applies = (dir: string) => calls(dir).filter(({ args }) => args.includes("apply"));

async function run(
  dir: string,
  ...args: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(
    [process.execPath, "run", join(dir, "scripts", "cire-db-migrate.ts"), ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** `wrangler d1 execute --json` output holding `results`. */
const rows = (...results: ReadonlyArray<Record<string, unknown>>) =>
  `${JSON.stringify([{ results, success: true, meta: {} }], null, 2)}\n`;

const ledgerTable = {
  name: "d1_migrations",
  sql: "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY)",
};
const ledgerOf = (names: readonly string[]) => rows(...names.map((name) => ({ name })));

const archive = archivedMigrations();
const baseline = migrationStatements(readFileSync(join(MIGRATIONS_DIR, BASELINE), "utf8"));
const PROD = ["cire-db", "--env", "production", "--remote"] as const;

describe.concurrent("before any wrangler call", () => {
  test("no arguments exit non-zero", async () => {
    const dir = tree({});
    const { exitCode, stdout, stderr } = await run(dir);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "::error::cire-db-migrate: the first argument must be the database name",
    );
    expect(exitCode).not.toBe(0);
    expect(calls(dir)).toEqual([]);
  });

  test("a target that is neither --local nor --remote exits non-zero", async () => {
    const dir = tree({});
    const { exitCode, stderr } = await run(dir, "cire-db", "--env", "production");
    expect(stderr).toContain("pass exactly one of --local or --remote");
    expect(exitCode).not.toBe(0);
    expect(calls(dir)).toEqual([]);
  });

  test("without cire/api's own wrangler it stops rather than fetch another", async () => {
    const dir = tree({}, false);
    const { exitCode, stderr } = await run(dir, ...PROD);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("cire/api has no wrangler of its own");
    expect(stderr).toContain("bun install --frozen-lockfile");
  });
});

describe.concurrent("a ledger the check refuses never reaches the apply", () => {
  test("production part-way through the archive", async () => {
    const dir = tree({
      schema: { out: rows(ledgerTable) },
      ledger: { out: ledgerOf(archive.filter((name) => name < "0062")) },
    });
    const { exitCode, stderr } = await run(dir, ...PROD);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("::error::cire-db-migrate: cire-db:");
    expect(stderr).toContain("0062_gift_note_hidden.sql");
    expect(stderr).toContain("0081_owner_notice_budget.sql");
    expect(applies(dir)).toEqual([]);
  });

  test("a baseline-only ledger over a schema this baseline did not build", async () => {
    const dir = tree({
      schema: {
        out: rows(ledgerTable, { name: "weddings", sql: "CREATE TABLE weddings (id text)" }),
      },
      ledger: { out: ledgerOf([BASELINE]) },
    });
    const { exitCode, stderr } = await run(dir, ...PROD);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("older baseline");
    expect(applies(dir)).toEqual([]);
  });

  test("a ledger without the baseline's name", async () => {
    const dir = tree({
      schema: { out: rows(ledgerTable) },
      ledger: { out: ledgerOf(["0002_add_rsvp_dietary.sql"]) },
    });
    expect((await run(dir, ...PROD)).exitCode).toBe(1);
    expect(applies(dir)).toEqual([]);
  });

  test("a stray migration numbered within the archive", async () => {
    const dir = tree({
      schema: { out: rows(ledgerTable) },
      ledger: { out: ledgerOf([BASELINE, "0058_myfeature.sql"]) },
    });
    const { exitCode, stderr } = await run(dir, ...PROD);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("0058_myfeature.sql");
    expect(applies(dir)).toEqual([]);
  });
});

describe.concurrent("a ledger that cannot be read never reaches the apply", () => {
  test("wrangler exits non-zero, as on an authentication error", async () => {
    const dir = tree({ schema: { out: '{"error":{"text":"Authentication error"}}', exit: 1 } });
    const { exitCode, stderr } = await run(dir, ...PROD);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not read the ledger of cire-db, so nothing was applied");
    expect(stderr).toContain("wrangler d1 execute exited 1");
    expect(applies(dir)).toEqual([]);
  });

  test("wrangler exits 0 with output that is not a result set", async () => {
    const dir = tree({ schema: { out: "not json\n" } });
    const { exitCode, stderr } = await run(dir, ...PROD);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not read the ledger");
    expect(applies(dir)).toEqual([]);
  });

  test("wrangler is killed mid-read, as a timeout kills it", async () => {
    const dir = tree({ schema: { kill: true } });
    const { exitCode, stderr } = await run(dir, ...PROD);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SIGKILL");
    expect(applies(dir)).toEqual([]);
  });

  test("the ledger read fails after the schema read succeeded", async () => {
    const dir = tree({ schema: { out: rows(ledgerTable) }, ledger: { out: "", exit: 1 } });
    expect((await run(dir, ...PROD)).exitCode).toBe(1);
    expect(applies(dir)).toEqual([]);
  });

  test("a ledger row with no readable name", async () => {
    const dir = tree({
      schema: { out: rows(ledgerTable) },
      ledger: { out: rows({ name: BASELINE }, { name: 58 }) },
    });
    const { exitCode, stderr } = await run(dir, ...PROD);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no readable name");
    expect(applies(dir)).toEqual([]);
  });
});

describe.concurrent("a ledger the check passes is applied once, to the same target", () => {
  test("a fresh database: one read, then the apply", async () => {
    const dir = tree({ schema: { out: rows() }, apply: {} });
    const { exitCode, stdout } = await run(dir, "cire-db", "--local");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("a fresh database");
    expect(calls(dir).map(({ args }) => args.includes("apply"))).toEqual([false, true]);
  });

  test("a database built from this baseline: no read beyond the schema and the ledger", async () => {
    const dir = tree({
      schema: {
        out: rows(ledgerTable, ...baseline.map((sql, i) => ({ name: `object_${i}`, sql }))),
      },
      ledger: { out: ledgerOf([BASELINE]) },
      apply: {},
    });
    const { exitCode, stdout } = await run(dir, ...PROD);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("built from this baseline");
    expect(calls(dir)).toHaveLength(3);
  });

  test("production complete: the reads and the apply carry the same target and config", async () => {
    const dir = tree({
      schema: { out: rows(ledgerTable) },
      ledger: { out: ledgerOf(archive) },
      apply: {},
    });
    const { exitCode } = await run(dir, ...PROD);
    expect(exitCode).toBe(0);
    const made = calls(dir);
    expect(made).toHaveLength(3);
    for (const { cwd, args } of made) {
      expect(cwd).toBe(join(dir, "cire", "api"));
      expect(args.slice(0, 2)).toEqual(["--config", join(dir, "cire", "api", "wrangler.toml")]);
      const at = args.indexOf("cire-db");
      expect(args.slice(at, at + PROD.length)).toEqual([...PROD]);
    }
    expect(made.at(-1)!.args.slice(2, 5)).toEqual(["d1", "migrations", "apply"]);
  });
});

describe.concurrent("the apply's exit status is the script's", () => {
  test("a failed apply fails the script with its code", async () => {
    const dir = tree({ schema: { out: rows() }, apply: { exit: 3 } });
    expect((await run(dir, "cire-db", "--local")).exitCode).toBe(3);
  });

  test("an apply killed by a signal fails the script", async () => {
    const dir = tree({ schema: { out: rows() }, apply: { kill: true } });
    expect((await run(dir, "cire-db", "--local")).exitCode).toBe(1);
  });
});
