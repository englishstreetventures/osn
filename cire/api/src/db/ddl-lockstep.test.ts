import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as cireSchema from "@cire/db";
import { is } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from "drizzle-orm/sqlite-core";

import { DDL } from "./setup";

// T-S1 — mechanical enforcement of the three-way DDL lockstep contract.
//
// The schema has three hand-maintained surfaces that must describe the same
// database shape:
//   1. cire/db/migrations/*.sql — what production D1 actually is,
//   2. the DDL string in src/db/setup.ts — what every bun:sqlite test runs on,
//   3. cire/db/src/schema.ts — what Drizzle believes at query-build time.
// Before this test the mirror was comment-enforced only: a migration that
// skipped the mirror let the whole cire/api suite pass against a shape D1
// rejects. Here we apply the full migration chain to one in-memory DB, the
// test DDL to another, and diff a NORMALISED structural snapshot of each
// (tables, columns, foreign keys, indexes, checks); the Drizzle schema is
// introspected via getTableConfig and diffed against the migrated DB too.
//
// Normalisation notes — differences we deliberately treat as equal:
// - Column ORDER is ignored (columns are keyed by name). D1's ALTER TABLE ADD
//   COLUMN can only append, so migrated order diverges cosmetically from the
//   mirrors; nothing in app code is positional. Rebuild migrations that copy
//   with `INSERT INTO t SELECT * FROM __keep_t` must still match the REAL
//   migrated order — which is exactly what the migrated DB here exhibits.
// - Index NAMES are ignored; an index is (unique, columns, partial-WHERE).
//   drizzle-kit spells column-level UNIQUE as a named `*_unique` index while
//   the mirror DDL uses inline UNIQUE (an autoindex) — same constraint.
// - Text primary keys count as NOT NULL on every surface. drizzle-kit emits
//   `PRIMARY KEY NOT NULL`; the mirror relies on `PRIMARY KEY` alone. (SQLite
//   legacy quirk: a non-INTEGER PK without NOT NULL technically admits NULLs,
//   but every insert path supplies an id.)

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations");

type ColumnShape = {
  type: string;
  notNull: boolean;
  default: string | null;
  /** 1-based position within the primary key; 0 = not part of it. */
  pk: number;
};
type ForeignKeyShape = {
  columns: string[];
  references: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
};
type IndexShape = { unique: boolean; columns: string[]; where: string | null };
type TableShape = {
  columns: Record<string, ColumnShape>;
  foreignKeys: ForeignKeyShape[];
  indexes: IndexShape[];
  checks: string[];
};
type SchemaSnapshot = {
  tables: Record<string, TableShape>;
  /** Triggers + views. None exist today — pinned so a future migration that
   * adds one can't silently skip the mirror (indexes are diffed per-table). */
  nonTableObjects: Array<{ type: string; name: string; sql: string }>;
};

/** Case/whitespace/identifier-quoting–insensitive form of a SQL fragment. */
const normalizeExpr = (raw: string): string =>
  raw.replaceAll(/[`"]/g, "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();

const sortByJson = <T>(items: T[]): T[] =>
  items.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Extracts every (normalised) CHECK expression from a CREATE TABLE statement. */
function extractChecks(tableSql: string): string[] {
  const checks: string[] = [];
  const re = /\bCHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tableSql))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < tableSql.length && depth > 0) {
      if (tableSql[i] === "(") depth += 1;
      else if (tableSql[i] === ")") depth -= 1;
      i += 1;
    }
    checks.push(normalizeExpr(tableSql.slice(start, i - 1)));
  }
  return checks.toSorted();
}

function snapshotSchema(db: Database): SchemaSnapshot {
  const tables = db
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string; sql: string }>;

  const snapshot: Record<string, TableShape> = {};
  for (const table of tables) {
    const columns: Record<string, ColumnShape> = {};
    const columnRows = db.query(`PRAGMA table_info("${table.name}")`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | number | null;
      pk: number;
    }>;
    for (const col of columnRows) {
      columns[col.name] = {
        type: col.type.toLowerCase(),
        notNull: col.notnull === 1 || col.pk > 0,
        default: col.dflt_value === null ? null : normalizeExpr(String(col.dflt_value)),
        pk: col.pk,
      };
    }

    const fkRows = db.query(`PRAGMA foreign_key_list("${table.name}")`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
      on_update: string;
      on_delete: string;
    }>;
    const fksById = new Map<number, ForeignKeyShape>();
    for (const row of fkRows.toSorted((a, b) => a.id - b.id || a.seq - b.seq)) {
      const fk = fksById.get(row.id) ?? {
        columns: [],
        references: row.table,
        refColumns: [],
        onUpdate: row.on_update.toLowerCase(),
        onDelete: row.on_delete.toLowerCase(),
      };
      fk.columns.push(row.from);
      // `to` is null only for an implicit reference to the parent's PK — no
      // migration or mirror uses that form today.
      fk.refColumns.push(row.to ?? "<implicit-pk>");
      fksById.set(row.id, fk);
    }

    const indexRows = db.query(`PRAGMA index_list("${table.name}")`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    const indexes: IndexShape[] = [];
    for (const idx of indexRows) {
      // The PK's autoindex is already pinned by the `pk` ordinals above.
      if (idx.origin === "pk") continue;
      const cols = (
        db.query(`PRAGMA index_info("${idx.name}")`).all() as Array<{
          seqno: number;
          name: string | null;
        }>
      )
        .toSorted((a, b) => a.seqno - b.seqno)
        .map((c) => c.name ?? "<expr>");
      let where: string | null = null;
      if (idx.partial === 1) {
        const row = db
          .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(idx.name) as { sql: string } | null;
        const whereMatch = row?.sql.match(/\bWHERE\b([\s\S]+)$/i);
        where = whereMatch?.[1] === undefined ? null : normalizeExpr(whereMatch[1]);
      }
      indexes.push({ unique: idx.unique === 1, columns: cols, where });
    }

    snapshot[table.name] = {
      columns,
      foreignKeys: sortByJson([...fksById.values()]),
      indexes: sortByJson(indexes),
      checks: extractChecks(table.sql),
    };
  }

  const nonTableObjects = (
    db
      .query(
        "SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string; sql: string }>
  ).map((o) => ({ type: o.type, name: o.name, sql: normalizeExpr(o.sql) }));

  return { tables: snapshot, nonTableObjects };
}

const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();

// `wrangler d1 migrations apply` runs the files in NAME order — that (not the
// drizzle-kit journal, which stopped being written when migrations went
// hand-authored after 0008) is the order production experienced.
function applyMigrations(): Database {
  const db = new Database(":memory:");
  // D1 enforces foreign keys unconditionally; every migration statement must
  // hold under that (see 0006's __keep_* idiom), so replay under the same rule.
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles()) {
    try {
      // `--> statement-breakpoint` lines are `--` SQL comments, so the whole
      // file execs as-is.
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (cause) {
      throw new Error(`migration ${file} failed to apply cleanly on sqlite`, { cause });
    }
  }
  return db;
}

function applyMirrorDdl(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(DDL);
  return db;
}

// ── Drizzle schema (cire/db/src/schema.ts) → TableShape ─────────────────────

const dialect = new SQLiteSyncDialect();

const sqlLiteral = (value: unknown): string => {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  // SQL-wrapped defaults (sql`...`) — render through the dialect.
  return dialect.sqlToQuery(value as SQL).sql;
};

function snapshotDrizzleTable(table: SQLiteTable): { name: string; shape: TableShape } {
  const config = getTableConfig(table);

  const pkOrdinal = new Map<string, number>();
  const compositePk = config.primaryKeys[0];
  if (compositePk) {
    compositePk.columns.forEach((col, i) => pkOrdinal.set(col.name, i + 1));
  }
  for (const col of config.columns) {
    if (col.primary) pkOrdinal.set(col.name, 1);
  }

  const columns: Record<string, ColumnShape> = {};
  const indexes: IndexShape[] = [];
  for (const col of config.columns) {
    columns[col.name] = {
      type: col.getSQLType().toLowerCase(),
      notNull: col.notNull || (pkOrdinal.get(col.name) ?? 0) > 0,
      default:
        col.hasDefault && col.default !== undefined ? normalizeExpr(sqlLiteral(col.default)) : null,
      pk: pkOrdinal.get(col.name) ?? 0,
    };
    // Column-level .unique() — drizzle-kit materialises it as a named unique
    // index; structurally it is a single-column unique constraint.
    if (col.isUnique) indexes.push({ unique: true, columns: [col.name], where: null });
  }

  for (const idx of config.indexes) {
    indexes.push({
      unique: idx.config.unique,
      columns: idx.config.columns.map((c) =>
        "name" in c ? (c as { name: string }).name : "<expr>",
      ),
      where: idx.config.where ? normalizeExpr(dialect.sqlToQuery(idx.config.where).sql) : null,
    });
  }

  const foreignKeys: ForeignKeyShape[] = config.foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      columns: ref.columns.map((c) => c.name),
      references: getTableConfig(ref.foreignTable).name,
      refColumns: ref.foreignColumns.map((c) => c.name),
      onUpdate: fk.onUpdate ?? "no action",
      onDelete: fk.onDelete ?? "no action",
    };
  });

  return {
    name: config.name,
    shape: {
      columns,
      foreignKeys: sortByJson(foreignKeys),
      indexes: sortByJson(indexes),
      checks: config.checks.map((c) => normalizeExpr(dialect.sqlToQuery(c.value).sql)).toSorted(),
    },
  };
}

const drizzleTables = Object.values(cireSchema).filter((v): v is SQLiteTable => is(v, SQLiteTable));

// Snapshot then release the native handle — the diffs below only need the
// plain snapshot objects (P-I1).
function snapshotAndClose(db: Database): SchemaSnapshot {
  try {
    return snapshotSchema(db);
  } finally {
    db.close();
  }
}

// ── The lockstep assertions ──────────────────────────────────────────────────

const migrated = snapshotAndClose(applyMigrations());

describe("T-S1 lockstep: migrations chain", () => {
  it("has a file for every drizzle-kit journal entry, in name order", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const tags = journal.entries.toSorted((a, b) => a.idx - b.idx).map((e) => `${e.tag}.sql`);
    expect(migrationFiles().slice(0, tags.length)).toEqual(tags);
  });

  it("leaves no __keep_* snapshot tables behind (rebuild recovery cleanup)", () => {
    expect(Object.keys(migrated.tables).filter((t) => t.startsWith("__keep_"))).toEqual([]);
  });
});

describe("T-S1 lockstep: setup.ts test DDL ↔ migrated D1 shape", () => {
  const mirror = snapshotAndClose(applyMirrorDdl());

  it("declares the same set of tables", () => {
    expect(Object.keys(mirror.tables).toSorted()).toEqual(Object.keys(migrated.tables).toSorted());
  });

  it("declares the same triggers and views (today: none)", () => {
    expect(mirror.nonTableObjects).toEqual(migrated.nonTableObjects);
  });

  for (const tableName of Object.keys(migrated.tables).toSorted()) {
    it(`mirrors "${tableName}" exactly`, () => {
      expect({ table: tableName, ...mirror.tables[tableName] }).toEqual({
        table: tableName,
        ...migrated.tables[tableName],
      });
    });
  }
});

describe("T-S1 lockstep: Drizzle schema.ts ↔ migrated D1 shape", () => {
  it("declares the same set of tables", () => {
    expect(drizzleTables.map((t) => getTableConfig(t).name).toSorted()).toEqual(
      Object.keys(migrated.tables).toSorted(),
    );
  });

  for (const table of drizzleTables) {
    const { name, shape } = snapshotDrizzleTable(table);
    it(`mirrors "${name}" exactly`, () => {
      expect({ table: name, ...shape }).toEqual({ table: name, ...migrated.tables[name] });
    });
  }
});
