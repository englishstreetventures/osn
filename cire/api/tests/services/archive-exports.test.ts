import { describe, expect, it } from "bun:test";

import {
  families,
  registryItems,
  seatingPlans,
  seatingTables,
  vendors,
  weddingFaqs,
  events,
} from "@cire/db";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { EffectDbService, effectDbFor } from "../../src/db/effect-handle";
import { localD1Binding } from "../../src/db/local-d1";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import {
  MAX_REGISTRY_EXPORT_ROWS,
  registryExportService,
} from "../../src/services/registry-export";
import { MAX_HOUSEHOLD_EXPORT_ROWS, rosterExportService } from "../../src/services/roster-export";
import { MAX_SEATING_EXPORT_ROWS, seatingExportService } from "../../src/services/seating-export";
import {
  MAX_QUESTION_EXPORT_ROWS,
  settingsExportService,
} from "../../src/services/settings-export";
import { MAX_VENDOR_EXPORT_ROWS, vendorExportService } from "../../src/services/vendor-export";
import { recordStatements } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

/**
 * B8 in `NEW-FEAT.md`: each file the archive adds stops its read one row past
 * its ceiling, in the database, so a wedding holding more never makes the
 * Worker receive, sort or print a row the file would not hold.
 */

const W = "w1";
const now = new Date("2026-10-01T00:00:00Z");

/** Inserts `rows` in chunks bun:sqlite's bound-parameter limit allows. */
function insertAll<T>(db: TestDb, table: Parameters<TestDb["insert"]>[0], rows: T[]) {
  for (let i = 0; i < rows.length; i += 200) {
    db.insert(table)
      .values(rows.slice(i, i + 200) as never)
      .run();
  }
}

function run<A>(db: TestDb, effect: Effect.Effect<A, never, DbService | EffectDbService>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(DbService, db),
      Effect.provideService(EffectDbService, effectDbFor(localD1Binding(db.$client), "fetch")),
    ),
  );
}

const cases: {
  file: string;
  ceiling: number;
  table: string;
  seed: (db: TestDb, n: number) => void;
  build: (weddingId: string) => Effect.Effect<string, never, DbService | EffectDbService>;
}[] = [
  {
    file: "households.csv",
    ceiling: MAX_HOUSEHOLD_EXPORT_ROWS,
    table: '"families"',
    seed: (db, n) =>
      insertAll(
        db,
        families,
        Array.from({ length: n }, (_, i) => ({
          id: `fam_${i}`,
          weddingId: W,
          publicId: `CODE-${i}`,
          familyName: `Family ${i}`,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    build: rosterExportService.householdsCsv,
  },
  {
    file: "vendors.csv",
    ceiling: MAX_VENDOR_EXPORT_ROWS,
    table: '"vendors"',
    seed: (db, n) =>
      insertAll(
        db,
        vendors,
        Array.from({ length: n }, (_, i) => ({
          id: `ven_${i}`,
          weddingId: W,
          name: `Vendor ${i}`,
          category: "florist",
          createdAt: now,
          updatedAt: now,
        })),
      ),
    build: vendorExportService.vendorsCsv,
  },
  {
    file: "registry.csv",
    ceiling: MAX_REGISTRY_EXPORT_ROWS,
    table: '"registry_items"',
    seed: (db, n) =>
      insertAll(
        db,
        registryItems,
        Array.from({ length: n }, (_, i) => ({
          id: `ritem_${i}`,
          weddingId: W,
          title: `Item ${i}`,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    build: registryExportService.itemsCsv,
  },
  {
    file: "questions.csv",
    ceiling: MAX_QUESTION_EXPORT_ROWS,
    table: '"wedding_faqs"',
    seed: (db, n) =>
      insertAll(
        db,
        weddingFaqs,
        Array.from({ length: n }, (_, i) => ({
          id: `faq_${i}`,
          weddingId: W,
          question: `Q ${i}`,
          answer: `A ${i}`,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    build: settingsExportService.questionsCsv,
  },
  {
    file: "seating-plans.csv",
    ceiling: MAX_SEATING_EXPORT_ROWS,
    table: '"seating_tables"',
    seed: (db, n) => {
      db.insert(events)
        .values({
          id: "evt_1",
          weddingId: W,
          slug: "reception",
          name: "Reception",
          startAt: "2027-01-01T18:00",
          endAt: "",
          timezone: "UTC",
        })
        .run();
      db.insert(seatingPlans)
        .values({
          id: "spl_1",
          weddingId: W,
          eventId: "evt_1",
          name: "Plan 1",
          selected: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      insertAll(
        db,
        seatingTables,
        Array.from({ length: n }, (_, i) => ({
          id: `stb_${i}`,
          weddingId: W,
          eventId: "evt_1",
          planId: "spl_1",
          name: `Table ${i}`,
          capacity: 8,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })),
      );
    },
    build: seatingExportService.allPlansCsv,
  },
];

describe("B8: each archive file stops its read one row past its ceiling", () => {
  for (const { file, ceiling, table, seed, build } of cases) {
    it(file, async () => {
      const db = createDb(":memory:");
      insertWedding(db, { id: W, slug: "w1", displayName: "One", owners: ["usr_owner"] });
      seed(db, ceiling + 2);
      const statements = recordStatements(db);
      const csv = await run(db, build(W));
      const reads = statements.filter((s) => s.sql.includes(table));
      expect(reads.map((s) => s.rowCounts)).toEqual([[ceiling + 1]]);
      // The header and the ceiling's rows; no cell here holds a line break.
      expect(csv.trimEnd().split("\r\n")).toHaveLength(ceiling + 1);
    });
  }
});
