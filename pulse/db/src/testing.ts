import type { Database } from "bun:sqlite";

import { is } from "drizzle-orm";
import {
  getTableConfig,
  SQLiteTable,
  type AnySQLiteColumn,
  type SQLiteColumn,
} from "drizzle-orm/sqlite-core";

import * as schema from "./schema";

/**
 * Build CREATE TABLE + CREATE INDEX statements for the live Pulse Drizzle
 * schema, in foreign-key-respecting order. Tests run these against a fresh
 * in-memory SQLite so that adding a column is a one-file change in
 * `src/schema/` rather than four hand-rolled DDL blocks.
 */
export function createSchemaSql(): string[] {
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

/**
 * Apply the full Pulse schema to an in-memory SQLite handle.
 */
export function applySchema(sqlite: Database): void {
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
    `[@pulse/db/testing] unsupported default for column "${col.name}": ${String(value)}. ` +
      `Extend formatDefault() in pulse/db/src/testing.ts to handle this case.`,
  );
}

interface IndexLike {
  config: {
    name: string;
    columns: ReadonlyArray<{ name?: string } | unknown>;
    unique: boolean;
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
          `[@pulse/db/testing] index "${cfg.name}" uses an SQL expression — ` +
            `extend emitCreateIndex() to handle non-column index entries.`,
        );
      }
      return `"${colName}"`;
    })
    .join(", ");
  return `CREATE ${cfg.unique ? "UNIQUE " : ""}INDEX "${cfg.name}" ON "${tableName}" (${cols});`;
}
