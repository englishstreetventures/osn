import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Change, parseNameStatus, refusals } from "../guard-migration-history";

const FILES: Record<string, string> = {
  "cire/db/migrations/20261021031500_add_bio.sql": "ALTER TABLE `weddings` ADD `bio` text;",
  "osn/db/drizzle/20261021031500_add_bio.sql": "ALTER TABLE `users` ADD `bio` text;",
  "cire/db/migrations/20261021031501_comments_only.sql": "-- nothing to run yet\n",
  "cire/db/migrations/20261021031502_empty.sql": "",
  "cire/db/migrations/20261021031503_rebuild.sql":
    "CREATE TABLE `__new_weddings` (`id` text);\nINSERT INTO `__new_weddings` SELECT `id` FROM `weddings`;",
};
const read = (path: string): string => {
  const sql = FILES[path];
  if (sql === undefined) throw new Error(`no fixture for ${path}`);
  return sql;
};
const check = (changes: Change[], allowRewrite = false) =>
  refusals(changes, read, { allowRewrite });
/** The single reason `changes` are refused, so a test can name the rule that fired. */
const onlyReason = (changes: Change[], allowRewrite = false): string => {
  const reasons = check(changes, allowRewrite);
  expect(reasons).toHaveLength(1);
  return reasons[0]!;
};

// ── what an ordinary migration pull request does ─────────────────────────────

test("a new timestamped migration passes", () => {
  expect(check([{ status: "A", path: "cire/db/migrations/20261021031500_add_bio.sql" }])).toEqual(
    [],
  );
  expect(check([{ status: "A", path: "osn/db/drizzle/20261021031500_add_bio.sql" }])).toEqual([]);
});

test("a README beside the migrations may change", () => {
  expect(check([{ status: "M", path: "cire/db/migrations-archive/README.md" }])).toEqual([]);
});

test("removing drizzle-kit's meta/ journal is not a rewrite: wrangler never read it", () => {
  expect(
    check([
      { status: "D", path: "cire/db/migrations/meta/_journal.json" },
      { status: "D", path: "osn/db/drizzle/meta/0010_snapshot.json" },
    ]),
  ).toEqual([]);
});

test("files outside the migration directories are not its business", () => {
  expect(check([{ status: "D", path: "cire/db/src/schema.ts" }])).toEqual([]);
});

// ── refusals: history that already ran ───────────────────────────────────────

test("refuses an edited migration", () => {
  expect(
    onlyReason([{ status: "M", path: "cire/db/migrations/0088_contribution_item_title.sql" }]),
  ).toContain("was edited after it merged");
});

test("refuses a deleted migration", () => {
  expect(onlyReason([{ status: "D", path: "pulse/db/drizzle/0003_close_friends.sql" }])).toContain(
    "was deleted after it merged",
  );
});

test("refuses a renamed migration", () => {
  expect(
    check([
      {
        status: "R",
        from: "cire/db/migrations/0089_seating.sql",
        path: "cire/db/migrations/0091_seating.sql",
      },
    ])[0],
  ).toContain("0089_seating.sql was renamed to");
});

test("refuses an edited archived migration", () => {
  expect(onlyReason([{ status: "M", path: "cire/db/migrations-archive/0033_x.sql" }])).toContain(
    "was edited after it merged",
  );
});

test("refuses a file added to the archive, which only a squash does", () => {
  expect(onlyReason([{ status: "A", path: "cire/db/migrations-archive/0092_late.sql" }])).toContain(
    "added to the archive",
  );
});

// ── refusals: a new file that is not a migration wrangler will run ───────────

test("refuses a numbered file: the number is what two branches collide on", () => {
  expect(onlyReason([{ status: "A", path: "cire/db/migrations/0091_seating.sql" }])).toContain(
    "is not named <YYYYMMDDHHMMSS>_<snake_name>.sql",
  );
});

test("refuses a drizzle-kit folder or a meta/ journal coming back", () => {
  expect(
    onlyReason([{ status: "A", path: "zap/db/drizzle/20261021031500_x/migration.sql" }]),
  ).toContain("is inside a directory");
  expect(onlyReason([{ status: "A", path: "zap/db/drizzle/meta/_journal.json" }])).toContain(
    "is inside a directory",
  );
});

test("refuses a migration with no statement in it", () => {
  expect(
    onlyReason([{ status: "A", path: "cire/db/migrations/20261021031501_comments_only.sql" }]),
  ).toContain("holds no statement");
  expect(
    onlyReason([{ status: "A", path: "cire/db/migrations/20261021031502_empty.sql" }]),
  ).toContain("holds no statement");
});

test("refuses a copy-and-swap table rebuild", () => {
  expect(
    onlyReason([{ status: "A", path: "cire/db/migrations/20261021031503_rebuild.sql" }]),
  ).toContain("copy-and-swap");
});

// ── the label ────────────────────────────────────────────────────────────────

test("the migrations:rewrite label lets a squash or a deliberate rebuild through", () => {
  const squash: Change[] = [
    {
      status: "R",
      from: "cire/db/migrations/0082_unlock_codes.sql",
      path: "cire/db/migrations-archive/0082_unlock_codes.sql",
    },
    { status: "M", path: "cire/db/migrations/0001_initial.sql" },
    { status: "A", path: "cire/db/migrations/20261021031503_rebuild.sql" },
  ];
  expect(check(squash)).not.toEqual([]);
  expect(check(squash, true)).toEqual([]);
});

test("the label never lets a migration with no statement through", () => {
  expect(
    onlyReason(
      [{ status: "A", path: "cire/db/migrations/20261021031501_comments_only.sql" }],
      true,
    ),
  ).toContain("holds no statement");
});

// ── reading git ──────────────────────────────────────────────────────────────

test("parseNameStatus reads adds, edits, deletes and renames", () => {
  expect(
    parseNameStatus(
      "A\tcire/db/migrations/20261021031500_add_bio.sql\nM\tREADME.md\nD\tx.sql\nR100\ta.sql\tb.sql\n",
    ),
  ).toEqual([
    { status: "A", path: "cire/db/migrations/20261021031500_add_bio.sql" },
    { status: "M", path: "README.md" },
    { status: "D", path: "x.sql" },
    { status: "R", from: "a.sql", path: "b.sql" },
  ]);
});

// ── the command, on a real repository ────────────────────────────────────────

/** Run the guard in a throwaway repository whose last commit makes `change`. */
function runOnCommit(change: (root: string) => void, args: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "guard-history-"));
  const git = (...a: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=g@t", "-c", "user.name=g", ...a], { cwd: root });
  try {
    mkdirSync(join(root, "cire", "db", "migrations"), { recursive: true });
    writeFileSync(
      join(root, "cire/db/migrations/0001_initial.sql"),
      "CREATE TABLE `t` (`id` text);",
    );
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    change(root);
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const result = Bun.spawnSync(
      [process.execPath, "run", join(import.meta.dir, "..", "guard-migration-history.ts"), ...args],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const NEW_FILE = "cire/db/migrations/20261021031500_add_bio.sql";
const BASELINE = "cire/db/migrations/0001_initial.sql";

test("the command passes a new timestamped migration and fails an edit, naming it", () => {
  const added = runOnCommit((root) =>
    writeFileSync(join(root, NEW_FILE), "ALTER TABLE `t` ADD `bio` text;"),
  );
  expect(added.exitCode).toBe(0);

  const edited = runOnCommit((root) =>
    writeFileSync(join(root, BASELINE), "CREATE TABLE `t` (`id` integer);"),
  );
  expect(edited.exitCode).toBe(1);
  expect(edited.output).toContain("0001_initial.sql was edited after it merged");
});

test("the command lets an edit through with --allow-rewrite", () => {
  const edited = runOnCommit(
    (root) => writeFileSync(join(root, BASELINE), "CREATE TABLE `t` (`id` integer);"),
    ["--allow-rewrite"],
  );
  expect(edited.exitCode).toBe(0);
});
