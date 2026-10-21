#!/usr/bin/env bun
/**
 * Generate the next migration for one database package, as a single flat file.
 *
 * Usage, as each db package's `db:generate` script calls it:
 *   db-generate.ts <package dir> --name <snake_case> [--from <rev>] [--custom] [--hints <json>]
 *
 * A migration here is one file, `<migrations dir>/<YYYYMMDDHHMMSS>_<name>.sql`,
 * stamped in UTC. Nothing else is committed with it: no journal, no snapshot.
 * Two branches that each add a migration therefore touch no file in common.
 *
 * drizzle-kit still writes the SQL. It needs a snapshot of the schema the
 * migration starts from, so this script builds one on the spot: it exports the
 * package's `src/` at `--from` (default `HEAD`) to a temporary directory and
 * has drizzle-kit snapshot it there, then runs drizzle-kit against the working
 * tree's schema with that snapshot as its only history. One parent, so none of
 * drizzle-kit's merge logic for branching histories is ever reached. Only the
 * resulting `migration.sql` is kept.
 *
 * Generate against the commit that holds every earlier migration of this
 * branch: commit one migration and its schema change before generating the
 * next. The script refuses to run while a `.sql` file in the migrations
 * directory is uncommitted, and refuses an empty diff (the schema change was
 * committed before generating: pass `--from <the commit before it>`).
 *
 * A rename is never guessed. On a terminal drizzle-kit asks; elsewhere it exits
 * 2 and prints the `--hints` JSON that answers it, and this script exits 2 too.
 *
 * Two pieces of drizzle-kit's SQLite output are corrected on the way out,
 * because the chain this repository already deployed does them otherwise:
 * a non-integer `PRIMARY KEY` gets `NOT NULL` (SQLite lets a text primary key
 * hold NULL), and a boolean default is written `1` or `0`, not `true` or
 * `false`. A table rebuild (`__new_<table>` copy-and-swap, or a migration that
 * switches foreign keys off) is refused outright: D1 enforces foreign keys, so
 * dropping a parent table cascades into its children. Write such a migration
 * by hand, with `--custom`, following `wiki/cire/cire-development.md`.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const NAME = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** Why `name` cannot name a migration, or null when it can. */
export function refuseName(name: string): string | null {
  return NAME.test(name)
    ? null
    : `"${name}" is not snake_case (lower-case letters and digits, single underscores between words)`;
}

/** `<YYYYMMDDHHMMSS>_<name>.sql` for `now`, in UTC. */
export function migrationFileName(now: Date, name: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp =
    pad(now.getUTCFullYear(), 4) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  return `${stamp}_${name}.sql`;
}

/** Why `sql` must not be generated (a copy-and-swap rebuild), or null. */
export function rebuildReason(sql: string): string | null {
  const swapped = /`(__new_\w+)`/.exec(sql);
  if (swapped) {
    return `it rebuilds a table by copy-and-swap (\`${swapped[1]}\`), which cascades deletes into every child table on D1`;
  }
  if (/PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql)) {
    return "it switches foreign keys off, which D1 ignores, so the statements after it run with foreign keys enforced";
  }
  return null;
}

/** drizzle-kit's SQLite output, corrected to how the deployed chain writes it. */
export function applyFixups(sql: string): string {
  return sql
    .replaceAll(
      /(`[^`]+` (?!integer\b)[a-z]+(?:\([^)]*\))? PRIMARY KEY)(?! NOT NULL)/gi,
      "$1 NOT NULL",
    )
    .replaceAll(/\bDEFAULT true\b/g, "DEFAULT 1")
    .replaceAll(/\bDEFAULT false\b/g, "DEFAULT 0");
}

interface Args {
  readonly packageDir: string;
  readonly name: string;
  readonly from: string;
  readonly custom: boolean;
  readonly hints: string | undefined;
}

export function parseArgs(argv: readonly string[]): Args | { readonly error: string } {
  const [packageDir, ...rest] = argv;
  if (packageDir === undefined || packageDir.startsWith("-")) {
    return { error: "the first argument must be the db package directory, e.g. cire/db" };
  }
  let name: string | undefined;
  let from = "HEAD";
  let custom = false;
  let hints: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--custom") {
      custom = true;
      continue;
    }
    if (value === undefined) return { error: `unknown or incomplete argument: ${flag}` };
    if (flag === "--name") name = value;
    else if (flag === "--from") from = value;
    else if (flag === "--hints") hints = value;
    else return { error: `unknown or incomplete argument: ${flag}` };
    i++;
  }
  if (name === undefined) return { error: "--name <snake_case> is required" };
  const refused = refuseName(name);
  if (refused) return { error: refused };
  return { packageDir: resolve(packageDir), name, from, custom, hints };
}

interface DrizzleConfig {
  readonly schema: string;
  readonly out: string;
}

const git = (cwd: string, args: readonly string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
};

function writeConfig(dir: string, schema: string, out: string): void {
  writeFileSync(
    join(dir, "drizzle.config.ts"),
    `export default ${JSON.stringify({ dialect: "sqlite", schema, out })};\n`,
  );
}

/** Run drizzle-kit `generate` in `cwd`; returns its exit code. */
function generate(drizzleKit: string, cwd: string, args: readonly string[]): number {
  const result = spawnSync(drizzleKit, ["generate", ...args], { cwd, stdio: "inherit" });
  return result.status ?? 1;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`db-generate: ${message}\n`);
  process.exit(code);
}

async function main(args: Args): Promise<void> {
  const { packageDir } = args;
  const config = (
    (await import(join(packageDir, "drizzle.config.ts"))) as { default: DrizzleConfig }
  ).default;
  const migrationsDir = resolve(packageDir, config.out);
  const schemaPath = resolve(packageDir, config.schema);
  const drizzleKit = join(packageDir, "node_modules", ".bin", "drizzle-kit");
  if (!existsSync(drizzleKit))
    fail(`${drizzleKit} is missing; run \`bun install --frozen-lockfile\``);

  const root = git(packageDir, ["rev-parse", "--show-toplevel"]).trim();
  const uncommitted = git(root, ["status", "--porcelain", "--", relative(root, migrationsDir)])
    .split("\n")
    .filter((line) => line.trim().endsWith(".sql"));
  if (uncommitted.length > 0) {
    fail(
      `commit the migration already in ${relative(root, migrationsDir)} first, or this one would repeat it:\n${uncommitted.join("\n")}`,
    );
  }

  const work = mkdtempSync(join(tmpdir(), "db-generate-"));
  try {
    const history = join(work, "history");
    const base = join(work, "base");
    const current = join(work, "current");
    for (const dir of [base, current]) {
      mkdirSync(dir);
      symlinkSync(join(packageDir, "node_modules"), join(dir, "node_modules"));
    }

    // The schema at `--from`: its `src/` exported as it stood then, snapshotted.
    const source = relative(root, join(packageDir, "src"));
    const archive = spawnSync("git", ["archive", "--format=tar", args.from, "--", source], {
      cwd: root,
      maxBuffer: 1 << 30,
    });
    if (archive.status !== 0)
      fail(`git archive ${args.from} failed: ${archive.stderr.toString().trim()}`);
    const untar = spawnSync("tar", ["-x", "-C", base], { input: archive.stdout });
    if (untar.status !== 0)
      fail(`could not unpack ${args.from}: ${untar.stderr.toString().trim()}`);
    writeConfig(base, join(base, source, relative(join(packageDir, "src"), schemaPath)), history);
    if (generate(drizzleKit, base, ["--name", "base"]) !== 0) {
      fail(`drizzle-kit could not snapshot the schema at ${args.from}`);
    }

    // The working tree's schema, against that one snapshot.
    writeConfig(current, schemaPath, history);
    const flags = ["--name", args.name, ...(args.custom ? ["--custom"] : [])];
    if (args.hints !== undefined) flags.push("--hints", args.hints);
    const code = generate(drizzleKit, current, flags);
    if (code !== 0)
      fail("drizzle-kit did not generate the migration (see above)", code === 2 ? 2 : 1);

    const made = readdirSync(history).filter((entry) => !entry.endsWith("_base"));
    if (made.length === 0) {
      fail(
        `no schema change since ${args.from}. If the change is already committed, pass --from <the commit before it>; ` +
          "for a data-only migration, pass --custom",
      );
    }
    const sql = applyFixups(readFileSync(join(history, made[0]!, "migration.sql"), "utf8"));
    const refused = rebuildReason(sql);
    if (refused)
      fail(`refusing this migration: ${refused}. Write it by hand with --custom instead.`);

    const file = join(migrationsDir, migrationFileName(new Date(), args.name));
    if (existsSync(file)) fail(`${basename(file)} already exists; wait a second and run again`);
    writeFileSync(file, sql);
    process.stdout.write(`${relative(root, file)}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  if ("error" in args) fail(args.error);
  await main(args);
}
