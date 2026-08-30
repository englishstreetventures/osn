import type { Database } from "bun:sqlite";

import { is, type SQL } from "drizzle-orm";
import {
  getTableConfig,
  SQLiteSyncDialect,
  SQLiteTable,
  type AnySQLiteColumn,
  type SQLiteColumn,
} from "drizzle-orm/sqlite-core";

import * as schema from "./schema";

/**
 * Build CREATE TABLE + CREATE INDEX statements for the live Zap Drizzle schema,
 * in foreign-key-respecting order. Tests run these against a fresh in-memory
 * SQLite (bun:sqlite) or a Miniflare-backed D1 so that adding a column is a
 * one-file change in `src/schema/` rather than a hand-rolled DDL block.
 *
 * Mirrors `@pulse/db/testing` — keep the two in sync if the emitter is extended.
 */
let cachedSchemaSql: string[] | undefined;

export function createSchemaSql(): string[] {
  // The Drizzle schema is a static module-level import, so the emitted DDL is
  // constant for the process lifetime. Reflecting it per test DB made ~24% of
  // setup pure recomputation, scaling with both test count and schema size.
  // Frozen: the array is shared by every caller, so a stray mutation must be loud.
  return (cachedSchemaSql ??= Object.freeze(buildSchemaSql()) as string[]);
}

function buildSchemaSql(): string[] {
  const tables = (Object.values(schema) as unknown[]).filter((value): value is SQLiteTable =>
    is(value, SQLiteTable),
  );
  const sorted = topoSortByForeignKey(tables);
  const out: string[] = [];
  for (const table of sorted) {
    out.push(emitCreateTable(table));
    for (const idx of getTableConfig(table).indexes) {
      out.push(emitCreateIndex(idx, table));
    }
  }
  return out;
}

/** Apply the full Zap schema to an in-memory bun:sqlite handle. */
export function applySchema(sqlite: Database): void {
  // SQLite defaults `foreign_keys` to OFF. D1 enforces them, so without this a
  // test database accepts writes production rejects — a statement that orphans
  // a row, or deletes a parent before its children, passes the whole suite and
  // fails on deploy with `FOREIGN KEY constraint failed`. Applied here rather
  // than at each call site so every test database built from the live schema
  // agrees with production about what is a legal write.
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const stmt of createSchemaSql()) sqlite.run(stmt);
}

function topoSortByForeignKey(tables: SQLiteTable[]): SQLiteTable[] {
  const visited = new Set<string>();
  const sorted: SQLiteTable[] = [];

  function visit(table: SQLiteTable): void {
    const cfg = getTableConfig(table);
    if (visited.has(cfg.name)) return;
    visited.add(cfg.name);
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      if (ref.foreignTable !== table) visit(ref.foreignTable);
    }
    sorted.push(table);
  }

  for (const t of tables) visit(t);
  return sorted;
}

/** Stateless with respect to a single `sqlToQuery` call — one instance is enough. */
const DIALECT = new SQLiteSyncDialect();

function emitCreateTable(table: SQLiteTable): string {
  const cfg = getTableConfig(table);
  const parts: string[] = [];

  for (const col of cfg.columns) parts.push("  " + emitColumn(col));

  for (const pk of cfg.primaryKeys) {
    const cols = pk.columns.map((c) => `"${c.name}"`).join(", ");
    parts.push(`  PRIMARY KEY (${cols})`);
  }

  for (const uq of cfg.uniqueConstraints) {
    const cols = uq.columns.map((c) => `"${c.name}"`).join(", ");
    const named = uq.name ? `CONSTRAINT "${uq.name}" ` : "";
    parts.push(`  ${named}UNIQUE (${cols})`);
  }

  for (const fk of cfg.foreignKeys) {
    const ref = fk.reference();
    const local = ref.columns.map((c) => `"${c.name}"`).join(", ");
    const foreignTableName = getTableConfig(ref.foreignTable).name;
    const foreignCols = ref.foreignColumns.map((c) => `"${c.name}"`).join(", ");
    parts.push(`  FOREIGN KEY (${local}) REFERENCES "${foreignTableName}"(${foreignCols})`);
  }

  return `CREATE TABLE "${cfg.name}" (\n${parts.join(",\n")}\n);`;
}

function emitColumn(col: AnySQLiteColumn): string {
  const parts = [`"${col.name}"`, col.getSQLType()];
  if (col.primary) parts.push("PRIMARY KEY");
  if (col.notNull) parts.push("NOT NULL");
  // Column-level `.unique()` lands on `col.isUnique`, not in the table config's
  // `uniqueConstraints` (table-level only). Zap's schema currently uses
  // `uniqueIndex()`/table-level `unique()` throughout, so this is latent here —
  // keep it so a future column-level `.unique()` isn't silently dropped.
  if (col.isUnique) parts.push("UNIQUE");
  if (col.hasDefault && col.default !== undefined) {
    parts.push(`DEFAULT ${formatDefault(col, col.default)}`);
  }
  return parts.join(" ");
}

function formatDefault(col: AnySQLiteColumn, value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value === null) return "NULL";
  throw new Error(
    `[@zap/db/testing] unsupported default for column "${col.name}": ${String(value)}. ` +
      `Extend formatDefault() in zap/db/src/testing.ts to handle this case.`,
  );
}

interface IndexLike {
  config: {
    name: string;
    columns: ReadonlyArray<{ name?: string } | unknown>;
    unique: boolean;
    where?: SQL;
  };
}

function emitCreateIndex(idx: IndexLike, table: SQLiteTable): string {
  const cfg = idx.config;
  const tableName = getTableConfig(table).name;
  const cols = cfg.columns
    .map((c) => {
      const colName = (c as SQLiteColumn).name;
      if (typeof colName !== "string") {
        throw new Error(
          `[@zap/db/testing] index "${cfg.name}" uses an SQL expression — ` +
            `extend emitCreateIndex() to handle non-column index entries.`,
        );
      }
      return `"${colName}"`;
    })
    .join(", ");
  // Partial indexes: without the WHERE clause a partial index silently becomes
  // a full one. Latent here (no `.where()` in this schema yet) — kept in step
  // with @osn/db/testing so a future partial index isn't silently widened.
  const where = cfg.where ? ` WHERE ${DIALECT.sqlToQuery(cfg.where).sql}` : "";
  return `CREATE ${cfg.unique ? "UNIQUE " : ""}INDEX "${cfg.name}" ON "${tableName}" (${cols})${where};`;
}
