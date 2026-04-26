import { Database } from "bun:sqlite";

import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, it, expect } from "vitest";

import * as schema from "../src/schema";
import { applySchema, createSchemaSql } from "../src/testing";

describe("createSchemaSql", () => {
  it("emits a CREATE TABLE for every SQLiteTable in src/schema", () => {
    const expected = (Object.values(schema) as unknown[])
      .filter((v): v is SQLiteTable => is(v, SQLiteTable))
      .map((t) => getTableConfig(t).name)
      .toSorted();

    const stmts = createSchemaSql();

    for (const tableName of expected) {
      expect(
        stmts.some((s) => s.startsWith(`CREATE TABLE "${tableName}"`)),
        `expected createSchemaSql() to emit CREATE TABLE for "${tableName}"`,
      ).toBe(true);
    }
  });

  it("orders foreign-key dependencies before dependents", () => {
    const stmts = createSchemaSql();
    const positionOf = (table: string) =>
      stmts.findIndex((s) => s.startsWith(`CREATE TABLE "${table}"`));

    expect(positionOf("event_series")).toBeLessThan(positionOf("events"));
    expect(positionOf("events")).toBeLessThan(positionOf("event_rsvps"));
    expect(positionOf("events")).toBeLessThan(positionOf("event_comms"));
  });
});

describe("applySchema", () => {
  it("creates every table in a fresh in-memory SQLite", () => {
    const sqlite = new Database(":memory:");
    applySchema(sqlite);
    const rows = sqlite
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all();
    expect(rows.map((r) => r.name)).toEqual([
      "event_comms",
      "event_rsvps",
      "event_series",
      "events",
      "pulse_close_friends",
      "pulse_users",
    ]);
  });

  it("creates every named index declared on the schema", () => {
    const sqlite = new Database(":memory:");
    applySchema(sqlite);
    const expected = (Object.values(schema) as unknown[])
      .filter((v): v is SQLiteTable => is(v, SQLiteTable))
      .flatMap((t) => getTableConfig(t).indexes.map((i) => i.config.name))
      .toSorted();
    const rows = sqlite
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all();
    expect(rows.map((r) => r.name)).toEqual(expected);
  });
});
