import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createSchemaSql } from "../src/testing";

// Mechanical enforcement of the Zap DDL lockstep contract, ported from
// osn/db's ddl-lockstep.test.ts.
//
// Two surfaces must describe the same database shape:
//   1. zap/db/drizzle/*.sql — what production D1 actually is,
//   2. `createSchemaSql()` — the schema-derived DDL every Zap test runs on
//      (bun:sqlite for the unit suites, Miniflare D1 for d1-integration).
//
// Surface 2 is emitted from src/schema/index.ts, so this also pins the Drizzle
// schema itself: a column added to schema.ts without a generated migration
// fails here, as does a migration applied without updating schema.ts.
//
// The emitter this pins is a copy of @osn/db's, which was found dropping
// column-level `.unique()` and partial-index WHERE clauses. This schema uses
// neither today, so that bug was latent here — this test is what keeps it so.
//
// Normalisation — differences deliberately treated as equal, and ONLY these:
// - Table-column ORDER is ignored (columns are keyed by name). D1's ALTER TABLE
//   ADD COLUMN can only append, so migrated order diverges cosmetically.
// - Index NAMES are ignored; an index is (unique, columns, partial-WHERE).
//   drizzle-kit spells column-level UNIQUE as a named `*_unique` index while
//   the emitter uses inline UNIQUE (an autoindex) — the same constraint.
//   Column order WITHIN an index is significant and is compared: SQLite can
//   only use an index for a leading prefix of its columns, so `(a, b)` and
//   `(b, a)` are different indexes.
// - Text primary keys count as NOT NULL on both surfaces. drizzle-kit emits
//   `PRIMARY KEY NOT NULL`; the emitter relies on `PRIMARY KEY` alone.
// - Boolean defaults: drizzle-kit writes `DEFAULT false`, the emitter writes
//   `DEFAULT 0`. SQLite has treated `false` as an alias for 0 since 3.23, and
//   both surfaces store the identical value — only PRAGMA's echoed literal
//   differs.

// `import.meta.dir` is Bun-only and undefined under vitest, which runs this suite.
const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "drizzle");

interface ColumnShape {
  type: string;
  notNull: boolean;
  default: string | null;
  /** 1-based position within the primary key; 0 = not part of it. */
  pk: number;
}
interface IndexShape {
  unique: boolean;
  columns: string[];
  where: string | null;
}
interface ForeignKeyShape {
  columns: string[];
  references: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}
interface TableShape {
  columns: Record<string, ColumnShape>;
  foreignKeys: ForeignKeyShape[];
  indexes: IndexShape[];
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();
}

/** Apply the full migration chain to a fresh in-memory database. */
function migratedDb(): Database {
  const db = new Database(":memory:");
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // drizzle-kit separates statements with this marker.
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) db.exec(trimmed);
    }
  }
  return db;
}

/** Apply the schema-derived DDL to a fresh in-memory database. */
function emittedDb(): Database {
  const db = new Database(":memory:");
  for (const stmt of createSchemaSql()) db.run(stmt);
  return db;
}

/** `DEFAULT false`/`DEFAULT true` and `DEFAULT 0`/`DEFAULT 1` are the same value. */
function normaliseDefault(value: string | null): string | null {
  if (value === "false") return "0";
  if (value === "true") return "1";
  return value;
}

/** Strips quoting and case so two spellings of the same SQL expression compare equal. */
const normaliseExpr = (raw: string): string =>
  raw.replaceAll(/[`"]/g, "").replaceAll(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();

/** Order the LIST of indexes/FKs (arbitrary) without reordering anything inside one. */
const sortByJson = <T>(items: T[]): T[] =>
  items.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function snapshot(db: Database): Record<string, TableShape> {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;

  const out: Record<string, TableShape> = {};
  for (const { name } of tables) {
    if (name === "__drizzle_migrations") continue;

    const cols = db.query(`PRAGMA table_info("${name}")`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    const columns: Record<string, ColumnShape> = {};
    for (const c of cols) {
      columns[c.name] = {
        type: c.type.toUpperCase(),
        // A primary key column is NOT NULL on every surface — see header note.
        notNull: c.notnull === 1 || c.pk > 0,
        default: normaliseDefault(c.dflt_value),
        pk: c.pk,
      };
    }

    // Foreign keys, grouped by `id` (a composite FK spans several rows).
    const fkRows = db.query(`PRAGMA foreign_key_list("${name}")`).all() as Array<{
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
      // `to` is null only for an implicit reference to the parent's PK.
      fk.refColumns.push(row.to ?? "<implicit-pk>");
      fksById.set(row.id, fk);
    }

    const idxList = db.query(`PRAGMA index_list("${name}")`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    const indexes: IndexShape[] = [];
    for (const i of idxList) {
      // The PK's autoindex is already pinned by the `pk` ordinals above.
      if (i.origin === "pk") continue;
      // seqno order is load-bearing — an index serves only a leading prefix.
      const indexCols = (
        db.query(`PRAGMA index_info("${i.name}")`).all() as Array<{
          seqno: number;
          name: string | null;
        }>
      )
        .toSorted((a, b) => a.seqno - b.seqno)
        .map((c) => c.name ?? "<expr>");
      let where: string | null = null;
      if (i.partial === 1) {
        const row = db
          .query("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
          .get(i.name) as { sql: string | null } | null;
        const match = row?.sql?.match(/\bWHERE\b([\s\S]+)$/i);
        where = match?.[1] === undefined ? null : normaliseExpr(match[1]);
      }
      // Not deduped: "migrations declare two indexes here, the emitter declares
      // one" is exactly the class of drift this test exists to catch.
      indexes.push({ unique: i.unique === 1, columns: indexCols, where });
    }

    out[name] = {
      columns,
      foreignKeys: sortByJson([...fksById.values()]),
      indexes: sortByJson(indexes),
    };
  }
  return out;
}

describe("Zap DDL lockstep", () => {
  const migrated = snapshot(migratedDb());
  const emitted = snapshot(emittedDb());

  it("the migration chain applies cleanly and creates tables", () => {
    expect(Object.keys(migrated).length).toBeGreaterThan(0);
  });

  it("covers the same set of tables", () => {
    expect(Object.keys(emitted).toSorted()).toEqual(Object.keys(migrated).toSorted());
  });

  it.each(Object.keys(migrated).toSorted())("table %s has matching columns", (table) => {
    expect(emitted[table]?.columns).toEqual(migrated[table].columns);
  });

  it.each(Object.keys(migrated).toSorted())(
    "table %s has matching indexes and constraints",
    (table) => {
      expect(emitted[table]?.indexes).toEqual(migrated[table].indexes);
    },
  );

  it.each(Object.keys(migrated).toSorted())("table %s has matching foreign keys", (table) => {
    expect(emitted[table]?.foreignKeys).toEqual(migrated[table].foreignKeys);
  });

  // osn has no CHECK constraints, triggers or views today. Pinned as empty so
  // the migration that introduces the first one can't skip the emitter.
  it("has no CHECK constraints, triggers or views on either surface", () => {
    const nonTableObjects = (db: Database): string[] =>
      (
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type IN ('trigger','view') AND sql IS NOT NULL",
          )
          .all() as Array<{ sql: string }>
      )
        .map((r) => normaliseExpr(r.sql))
        .toSorted();
    const checks = (db: Database): string[] =>
      (
        db
          .query("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL")
          .all() as Array<{ sql: string }>
      )
        .filter((r) => /\bCHECK\s*\(/i.test(r.sql))
        .map((r) => normaliseExpr(r.sql))
        .toSorted();

    expect(nonTableObjects(emittedDb())).toEqual(nonTableObjects(migratedDb()));
    expect(checks(emittedDb())).toEqual(checks(migratedDb()));
  });
});
