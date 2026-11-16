import { describe, expect, it } from "bun:test";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import * as schema from "../src/schema";

// Every events read filters by wedding and orders by sort_order, so the schema
// declares one composite index, events_wedding_id_sort_idx, and neither the
// single-column events_sort_order_idx nor events_wedding_idx.
// cire/api/tests/db/ddl-lockstep.test.ts holds this schema, cire/api/src/db/setup.ts
// and the migrations to the same index shapes but ignores index names, so this
// test is what pins them.
describe("events schema indexes", () => {
  it("declares the (wedding_id, sort_order) composite index", () => {
    const { indexes } = getTableConfig(schema.events);
    const indexNames = new Set(indexes.map((i) => i.config.name));
    expect(indexNames.has("events_wedding_id_sort_idx")).toBe(true);
  });

  it("does not re-declare the dropped single-column indexes", () => {
    const { indexes } = getTableConfig(schema.events);
    const indexNames = new Set(indexes.map((i) => i.config.name));
    expect(indexNames.has("events_sort_order_idx")).toBe(false);
    expect(indexNames.has("events_wedding_idx")).toBe(false);
  });
});

// The change-log readers that tell organisers about changes admit only
// RSVP_CHANGE_KINDS, so a kind an organiser's write records must never be one.
describe("rsvp_changes kinds", () => {
  it("keeps the household's kinds and the organiser's apart", () => {
    const household = new Set<string>(schema.RSVP_CHANGE_KINDS);
    expect(schema.RSVP_HOST_CHANGE_KINDS.filter((kind) => household.has(kind))).toEqual([]);
  });
});
