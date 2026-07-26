/**
 * `rowsChanged` normalises the rows-affected field across every driver this
 * repo runs on. The bug it exists to prevent: tests run on bun:sqlite
 * (`{ changes }`) while production runs on D1 (`{ meta: { changes } }`), so a
 * naive `result.changes` read is green locally and 0 everywhere in production.
 */

import { describe, expect, it } from "vitest";

import { rowsChanged } from "../src/index";

describe("rowsChanged", () => {
  it("reads bun:sqlite / better-sqlite3 `{ changes }`", () => {
    expect(rowsChanged({ changes: 1 })).toBe(1);
    expect(rowsChanged({ changes: 0 })).toBe(0);
    expect(rowsChanged({ changes: 7, lastInsertRowid: 42 })).toBe(7);
  });

  it("reads libsql `{ rowsAffected }`", () => {
    expect(rowsChanged({ rowsAffected: 1 })).toBe(1);
    expect(rowsChanged({ rowsAffected: 0 })).toBe(0);
  });

  it("reads D1 `{ success, meta: { changes } }` — the production shape", () => {
    expect(rowsChanged({ success: true, meta: { changes: 1, duration: 0.3 }, results: [] })).toBe(
      1,
    );
    expect(rowsChanged({ success: true, meta: { changes: 0 }, results: [] })).toBe(0);
  });

  it("prefers `meta.changes` when a driver reports both", () => {
    expect(rowsChanged({ changes: 0, meta: { changes: 3 } })).toBe(3);
  });

  it("falls back to `changes` when `meta` carries no count", () => {
    expect(rowsChanged({ changes: 2, meta: {} })).toBe(2);
    expect(rowsChanged({ changes: 2, meta: null })).toBe(2);
  });

  it("returns 0 for shapes it cannot read", () => {
    expect(rowsChanged(null)).toBe(0);
    expect(rowsChanged(undefined)).toBe(0);
    expect(rowsChanged({})).toBe(0);
    expect(rowsChanged("1")).toBe(0);
    expect(rowsChanged(1)).toBe(0);
    expect(rowsChanged([])).toBe(0);
  });
});
