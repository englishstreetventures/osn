#!/usr/bin/env bun
/**
 * Refuse a pull request that rewrites migration history, or adds a migration
 * wrangler would not run as written.
 *
 * Usage, from `.github/workflows/migration-history.yml` on a pull request's
 * merge ref: `guard-migration-history.ts [--allow-rewrite]`. It reads
 * `git diff --name-status HEAD^1 HEAD`, which on that ref is exactly what the
 * pull request changes, and needs a checkout two commits deep.
 *
 * It reads the repository from the working directory, never from its own
 * path: the workflow runs `main`'s copy of this file from a checkout of its
 * own, with the pull request's checkout as the working directory.
 *
 * A deployed database records each migration it applied by file name, and
 * never looks at that file again. So, under the migration directories:
 *
 * - a migration already merged is never edited, deleted or renamed: the edit
 *   reaches no database that applied it, and a rename is applied again;
 * - a new migration is one flat `<YYYYMMDDHHMMSS>_<snake_name>.sql` file, as
 *   `db:generate` writes it. A number would collide with a parallel branch's,
 *   and a folder or a `meta/` journal is something wrangler never applies;
 * - a new migration holds at least one statement;
 * - a new migration does not rebuild a table by copy-and-swap, which D1 turns
 *   into a cascading delete.
 *
 * `--allow-rewrite`, passed when the pull request carries the
 * `migrations:rewrite` label, lifts every rule but the one about statements:
 * squashing the chain into a new baseline (`cire/db/README.md`) moves and
 * rewrites files on purpose, and a hand-written rebuild is sometimes the only
 * way. Files other than `.sql` (a README) are never refused.
 *
 * Imports nothing but Node built-ins and sibling scripts, so the CI job that
 * runs it needs no install.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { rebuildReason } from "./db-generate";
import { migrationStatements } from "./migration-files";

/** Every directory wrangler applies migrations from, plus cire's archive. */
export const MIGRATION_DIRS = [
  "cire/db/migrations",
  "cire/db/migrations-archive",
  "osn/db/drizzle",
  "pulse/db/drizzle",
  "zap/db/drizzle",
] as const;

const NEW_MIGRATION = /^\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export type Change =
  | { readonly status: "A" | "M" | "D" | "T"; readonly path: string }
  | { readonly status: "R" | "C"; readonly from: string; readonly path: string };

/**
 * `git diff -z --name-status` output, renames and copies included. NUL-separated
 * because the default output quotes a path holding a tab, a quote or a byte
 * above 0x7F, and a quoted path would match no migration directory.
 */
export function parseNameStatus(output: string): Change[] {
  const fields = output.split("\0").filter((field) => field !== "");
  const lines: string[] = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i]!;
    const paths = code.startsWith("R") || code.startsWith("C") ? 2 : 1;
    lines.push([code, ...fields.slice(i + 1, i + 1 + paths)].join("\t"));
    i += 1 + paths;
  }
  return lines.map((line): Change => {
    const [code = "", first = "", second] = line.split("\t");
    const status = code[0];
    if ((status === "R" || status === "C") && second !== undefined) {
      return { status, from: first, path: second };
    }
    if (status === "A" || status === "M" || status === "D" || status === "T") {
      return { status, path: first };
    }
    throw new Error(`unreadable git diff line: ${line}`);
  });
}

/** The migration directory `path` sits under, and the part of it below that. */
function locate(path: string): { readonly dir: string; readonly rest: string } | null {
  for (const dir of MIGRATION_DIRS) {
    if (path.startsWith(`${dir}/`)) return { dir, rest: path.slice(dir.length + 1) };
  }
  return null;
}

/**
 * History is the `.sql` files: editing, deleting or renaming anything else
 * there (a README, drizzle-kit's old `meta/` journal) rewrites nothing a
 * database ran. An added file is checked whatever its kind, because anything
 * new beside the migrations is either a migration or something that looks
 * like one and would never run.
 */
const isHistory = (rest: string): boolean => rest.endsWith(".sql");

export interface Options {
  readonly allowRewrite: boolean;
}

/** Why the changes cannot merge, one line each; empty when they can. */
export function refusals(
  changes: readonly Change[],
  read: (path: string) => string,
  { allowRewrite }: Options,
): string[] {
  const reasons: string[] = [];
  const rewrite = (reason: string) => {
    if (!allowRewrite) reasons.push(`${reason} (only with the migrations:rewrite label)`);
  };

  for (const change of changes) {
    if (change.status === "R" || change.status === "C") {
      const from = locate(change.from);
      if (from && isHistory(from.rest)) rewrite(`${change.from} was renamed to ${change.path}`);
    }
    const at = locate(change.path);
    if (!at) continue;
    const added = change.status === "A" || change.status === "R" || change.status === "C";
    if (!added && !isHistory(at.rest)) continue;
    if (added && !at.rest.includes("/") && !at.rest.endsWith(".sql")) continue;

    if (change.status === "M" || change.status === "T") {
      rewrite(`${change.path} was edited after it merged`);
      continue;
    }
    if (change.status === "D") {
      rewrite(`${change.path} was deleted after it merged`);
      continue;
    }

    // An added file: a new migration, or a file moved here.
    if (at.dir === "cire/db/migrations-archive") {
      rewrite(`${change.path} was added to the archive, which only a squash does`);
      continue;
    }
    if (at.rest.includes("/")) {
      rewrite(
        `${change.path} is inside a directory; wrangler applies only files directly in ${at.dir}`,
      );
      continue;
    }
    if (!NEW_MIGRATION.test(at.rest)) {
      rewrite(`${change.path} is not named <YYYYMMDDHHMMSS>_<snake_name>.sql; use db:generate`);
      continue;
    }
    const sql = read(change.path);
    if (migrationStatements(sql).length === 0) {
      reasons.push(`${change.path} holds no statement for wrangler to run`);
      continue;
    }
    const rebuild = rebuildReason(sql);
    if (rebuild) rewrite(`${change.path}: ${rebuild}`);
  }
  return reasons;
}

if (import.meta.main) {
  const allowRewrite = Bun.argv.slice(2).includes("--allow-rewrite");
  const diff = spawnSync(
    "git",
    ["diff", "-z", "--name-status", "--find-renames", "HEAD^1", "HEAD"],
    {
      encoding: "utf8",
    },
  );
  if (diff.status !== 0) {
    process.stderr.write(
      `::error::guard-migration-history: git diff HEAD^1 HEAD failed; the checkout needs fetch-depth: 2. ${diff.stderr.trim()}\n`,
    );
    process.exit(1);
  }
  const reasons = refusals(parseNameStatus(diff.stdout), (path) => readFileSync(path, "utf8"), {
    allowRewrite,
  });
  for (const reason of reasons) {
    process.stderr.write(`::error::guard-migration-history: ${reason}\n`);
  }
  if (reasons.length === 0)
    process.stdout.write("guard-migration-history: no migration history rewritten\n");
  process.exit(reasons.length === 0 ? 0 : 1);
}
