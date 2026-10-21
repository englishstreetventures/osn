import { expect, test } from "bun:test";

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
    check([{ status: "M", path: "cire/db/migrations/0088_contribution_item_title.sql" }]),
  ).toHaveLength(1);
});

test("refuses a deleted migration", () => {
  expect(check([{ status: "D", path: "pulse/db/drizzle/0003_close_friends.sql" }])).toHaveLength(1);
});

test("refuses a renamed migration", () => {
  expect(
    check([
      {
        status: "R",
        from: "cire/db/migrations/0089_seating.sql",
        path: "cire/db/migrations/0091_seating.sql",
      },
    ]),
  ).not.toEqual([]);
});

test("refuses an edited archived migration", () => {
  expect(check([{ status: "M", path: "cire/db/migrations-archive/0033_x.sql" }])).toHaveLength(1);
});

// ── refusals: a new file that is not a migration wrangler will run ───────────

test("refuses a numbered file: the number is what two branches collide on", () => {
  expect(check([{ status: "A", path: "cire/db/migrations/0091_seating.sql" }])).toHaveLength(1);
});

test("refuses a drizzle-kit folder or a meta/ journal coming back", () => {
  expect(
    check([{ status: "A", path: "zap/db/drizzle/20261021031500_x/migration.sql" }]),
  ).toHaveLength(1);
  expect(check([{ status: "A", path: "zap/db/drizzle/meta/_journal.json" }])).toHaveLength(1);
});

test("refuses a migration with no statement in it", () => {
  expect(
    check([{ status: "A", path: "cire/db/migrations/20261021031501_comments_only.sql" }]),
  ).toHaveLength(1);
  expect(
    check([{ status: "A", path: "cire/db/migrations/20261021031502_empty.sql" }]),
  ).toHaveLength(1);
});

test("refuses a copy-and-swap table rebuild", () => {
  expect(
    check([{ status: "A", path: "cire/db/migrations/20261021031503_rebuild.sql" }]),
  ).toHaveLength(1);
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
    check([{ status: "A", path: "cire/db/migrations/20261021031501_comments_only.sql" }], true),
  ).toHaveLength(1);
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
