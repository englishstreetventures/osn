import { describe, expect, it } from "bun:test";

import { registryContributions, weddings, weddingUpgradePurchases } from "@cire/db";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { CLAIM_TTL_MS } from "../../src/services/changes";
import {
  MAX_PURGES_PER_RUN,
  maintenanceSweeps,
  PURGE_PENDING_HOLD_S,
} from "../../src/services/maintenance-sweeps";
import type { DeletableBucket } from "../../src/services/r2-cleanup";
import {
  fullWeddingKeys,
  fullWeddingStatements,
  WEDDING_CHILD_TABLES,
} from "../test-helpers/full-wedding";
import { counterValue } from "../test-helpers/metrics-harness";

/**
 * The daily purge of soft-deleted weddings past their restore window.
 *
 * bun:sqlite runs a batch's statements one at a time; what these tests show is
 * each statement's predicate. That the key reads and the delete commit as one
 * transaction, and that the reads stay inside D1's compound-SELECT limit, is
 * shown on Miniflare D1 in `tests/db/d1-integration.test.ts`.
 */

const NOW = new Date("2026-10-01T04:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

function makeDb(): TestDb {
  return createDb(":memory:");
}

function seedWedding(db: TestDb, id: string, deletedAt: Date | null) {
  for (const statement of fullWeddingStatements(id, { deletedAt, now: daysAgo(30) })) {
    db.run(statement);
  }
}

const countFor = (db: TestDb, table: string, weddingId: string): number => {
  // Every child table either carries `wedding_id` or hangs off one that does.
  const viaFamily = ["guests", "sessions"];
  const viaGuest = ["guest_events", "rsvps"];
  let query: string;
  if (viaFamily.includes(table)) {
    query = `SELECT count(*) AS n FROM ${table} WHERE family_id IN (SELECT id FROM families WHERE wedding_id = '${weddingId}')`;
  } else if (viaGuest.includes(table)) {
    query = `SELECT count(*) AS n FROM ${table} WHERE guest_id IN (SELECT g.id FROM guests g JOIN families f ON f.id = g.family_id WHERE f.wedding_id = '${weddingId}')`;
  } else if (table === "payments") {
    query = `SELECT count(*) AS n FROM payments WHERE budget_item_id IN (SELECT id FROM budget_items WHERE wedding_id = '${weddingId}')`;
  } else {
    query = `SELECT count(*) AS n FROM ${table} WHERE wedding_id = '${weddingId}'`;
  }
  return db.all<{ n: number }>(sql.raw(query))[0]!.n;
};

const totalRows = (db: TestDb, table: string): number =>
  db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`))[0]!.n;

function recordingBucket(): DeletableBucket & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    delete(keys: string | string[]) {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };
}

const purge = (db: TestDb, buckets = {}, now = NOW) =>
  Effect.runPromise(
    maintenanceSweeps.purgeDeletedWeddings(now, buckets).pipe(Effect.provideService(DbService, db)),
  );

const exists = (db: TestDb, id: string) =>
  db.select({ id: weddings.id }).from(weddings).where(eq(weddings.id, id)).all().length === 1;

describe("maintenanceSweeps.purgeDeletedWeddings", () => {
  it("hard-deletes a wedding past its window, every child row with it, and nothing else", async () => {
    const db = makeDb();
    seedWedding(db, "wed_gone", daysAgo(8));
    seedWedding(db, "wed_live", null);
    for (const table of WEDDING_CHILD_TABLES) {
      expect(countFor(db, table, "wed_gone")).toBeGreaterThan(0);
    }
    const before = await counterValue(CIRE_METRICS.weddingPurged, { result: "ok" });

    const sheets = recordingBucket();
    const assets = recordingBucket();
    const run = await purge(db, { sheets, assets });

    expect(run).toEqual({ purged: 1, held: 0, errors: 0, backlog: 0 });
    expect(exists(db, "wed_gone")).toBe(false);
    for (const table of WEDDING_CHILD_TABLES) {
      expect({ table, n: countFor(db, table, "wed_gone") }).toEqual({ table, n: 0 });
      expect({ table, n: countFor(db, table, "wed_live") }).toEqual({ table, n: 1 });
    }
    // The record of money cire took has no foreign key and outlives the purge.
    expect(totalRows(db, "platform_sales")).toBe(2);
    // The shared listing an enquiry named is not the wedding's.
    expect(totalRows(db, "directory_vendors")).toBe(2);

    const keys = fullWeddingKeys("wed_gone");
    expect(sheets.deleted.toSorted()).toEqual(keys.sheets.toSorted());
    expect(assets.deleted.toSorted()).toEqual(keys.assets.toSorted());
    expect(await counterValue(CIRE_METRICS.weddingPurged, { result: "ok" })).toBe(before + 1);
  });

  it("leaves a wedding still inside its restore window", async () => {
    const db = makeDb();
    seedWedding(db, "wed_recent", daysAgo(6));
    expect(await purge(db)).toEqual({ purged: 0, held: 0, errors: 0, backlog: 0 });
    expect(exists(db, "wed_recent")).toBe(true);
  });

  it("never touches a live wedding", async () => {
    const db = makeDb();
    seedWedding(db, "wed_live", null);
    expect((await purge(db)).purged).toBe(0);
    expect(exists(db, "wed_live")).toBe(true);
  });

  describe("holds a wedding while money can still move", () => {
    it("a pending gift or purchase under the hold, and not once it has aged out", async () => {
      const db = makeDb();
      seedWedding(db, "wed_gift", daysAgo(8));
      seedWedding(db, "wed_upg", daysAgo(8));
      const recent = new Date(NOW.getTime() - (PURGE_PENDING_HOLD_S - 3600) * 1000);
      db.update(registryContributions)
        .set({ status: "pending", createdAt: recent })
        .where(eq(registryContributions.weddingId, "wed_gift"))
        .run();
      db.update(weddingUpgradePurchases)
        .set({ status: "pending", createdAt: recent })
        .where(eq(weddingUpgradePurchases.weddingId, "wed_upg"))
        .run();
      const heldBefore = await counterValue(CIRE_METRICS.weddingPurged, { result: "held" });

      expect(await purge(db)).toEqual({ purged: 0, held: 2, errors: 0, backlog: 0 });
      expect(exists(db, "wed_gift") && exists(db, "wed_upg")).toBe(true);
      expect(await counterValue(CIRE_METRICS.weddingPurged, { result: "held" })).toBe(
        heldBefore + 2,
      );

      // Two hours later both rows are past the hold.
      const later = new Date(NOW.getTime() + 2 * 3600 * 1000);
      expect((await purge(db, {}, later)).purged).toBe(2);
    });

    it("a disputed gift, however old", async () => {
      const db = makeDb();
      seedWedding(db, "wed_disputed", daysAgo(60));
      db.update(registryContributions)
        .set({ status: "disputed", createdAt: daysAgo(90) })
        .where(eq(registryContributions.weddingId, "wed_disputed"))
        .run();
      expect((await purge(db)).held).toBe(1);
      expect(exists(db, "wed_disputed")).toBe(true);
    });

    it("a change still writing", async () => {
      const db = makeDb();
      seedWedding(db, "wed_change", daysAgo(8));
      db.update(weddings)
        .set({ changeClaim: "tok", changeClaimedAt: NOW.getTime() - 1_000 })
        .where(eq(weddings.id, "wed_change"))
        .run();
      expect((await purge(db)).held).toBe(1);
      db.update(weddings)
        .set({ changeClaimedAt: NOW.getTime() - CLAIM_TTL_MS - 1_000 })
        .where(eq(weddings.id, "wed_change"))
        .run();
      expect((await purge(db)).purged).toBe(1);
    });
  });

  it("purges at most its cap a run, oldest first, and reports the backlog", async () => {
    const db = makeDb();
    const total = MAX_PURGES_PER_RUN + 2;
    for (let i = 0; i < total; i++) seedWedding(db, `wed_${i}`, daysAgo(20 - i));
    // A held wedding older than all of them must not take a slot.
    seedWedding(db, "wed_held", daysAgo(40));
    db.update(registryContributions)
      .set({ status: "disputed" })
      .where(eq(registryContributions.weddingId, "wed_held"))
      .run();

    const run = await purge(db);
    expect(run).toEqual({ purged: MAX_PURGES_PER_RUN, held: 1, errors: 0, backlog: 2 });
    for (let i = 0; i < MAX_PURGES_PER_RUN; i++) expect(exists(db, `wed_${i}`)).toBe(false);
    expect(exists(db, `wed_${MAX_PURGES_PER_RUN}`)).toBe(true);
    expect(exists(db, "wed_held")).toBe(true);

    expect((await purge(db)).purged).toBe(2);
  });

  it("still purges when a bucket refuses to delete; the objects are logged and counted", async () => {
    const db = makeDb();
    seedWedding(db, "wed_gone", daysAgo(8));
    const failing: DeletableBucket = {
      delete: () => Promise.reject(new Error("r2 down")),
    };
    const before = await counterValue(CIRE_METRICS.r2ObjectsSwept, {
      bucket: "assets",
      result: "error",
    });
    expect((await purge(db, { sheets: failing, assets: failing })).purged).toBe(1);
    expect(exists(db, "wed_gone")).toBe(false);
    expect(
      await counterValue(CIRE_METRICS.r2ObjectsSwept, { bucket: "assets", result: "error" }),
    ).toBe(before + 5);
  });

  it("does not purge a wedding restored after the candidate read", async () => {
    // The delete re-checks the window itself, so a restore that lands between
    // the candidate read and the per-wedding batch wins. The restore is made
    // to land there by running it as the batch's delete is being built.
    const db = makeDb();
    seedWedding(db, "wed_back", daysAgo(8));
    const raced = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "delete") {
          return (table: typeof weddings) => {
            target
              .update(weddings)
              .set({ deletedAt: null, deletedByOsnProfileId: null })
              .where(eq(weddings.id, "wed_back"))
              .run();
            return target.delete(table);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const run = await Effect.runPromise(
      maintenanceSweeps.purgeDeletedWeddings(NOW).pipe(Effect.provideService(DbService, raced)),
    );
    expect(run).toEqual({ purged: 0, held: 1, errors: 0, backlog: 0 });
    expect(exists(db, "wed_back")).toBe(true);
  });
});
