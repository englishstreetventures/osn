import { describe, expect, it } from "bun:test";

import { directoryVendors, imports, vendorClaims, BOOTSTRAP_WEDDING_ID } from "@cire/db";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import type { Db } from "../../src/db";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { maintenanceSweeps, PREVIEW_STALE_AFTER_MS } from "../../src/services/maintenance-sweeps";
import type { DeletableBucket } from "../../src/services/r2-cleanup";

const NOW = new Date("2026-07-30T04:00:00.000Z");

function makeDb(): { db: TestDb; layer: Layer.Layer<DbService> } {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  return { db, layer: Layer.succeed(DbService, db) };
}

function seedListing(db: TestDb, id: string): void {
  db.insert(directoryVendors)
    .values({ id, name: "Vendor", listed: "draft", createdAt: NOW, updatedAt: NOW })
    .run();
}

function seedClaim(db: TestDb, id: string, expiresAt: Date, consumedAt: Date | null = null): void {
  db.insert(vendorClaims)
    .values({
      id,
      directoryVendorId: "dv_1",
      tokenHash: `hash-${id}`,
      email: "v@example.com",
      createdAt: NOW,
      expiresAt,
      consumedAt,
    })
    .run();
}

function seedImport(
  db: TestDb,
  id: string,
  status: "preview" | "applied",
  uploadedAt: number,
): void {
  db.insert(imports)
    .values({
      id,
      weddingId: BOOTSTRAP_WEDDING_ID,
      uploadedAt,
      format: "csv",
      eventsR2Key: `sheets/${id}/events.csv`,
      guestsR2Key: `sheets/${id}/guests.csv`,
      summary: "{}",
      status,
    })
    .run();
}

describe("maintenanceSweeps.sweepExpiredVendorClaims", () => {
  it("deletes expired claims (consumed or not) and keeps live ones", async () => {
    const { db, layer } = makeDb();
    seedListing(db, "dv_1");
    seedClaim(db, "vc_expired", new Date(NOW.getTime() - 1000));
    seedClaim(db, "vc_expired_consumed", new Date(NOW.getTime() - 1000), NOW);
    seedClaim(db, "vc_live", new Date(NOW.getTime() + 1000));
    // Consumed but unexpired: kept until expiry (audit value).
    seedClaim(db, "vc_live_consumed", new Date(NOW.getTime() + 1000), NOW);

    const deleted = await Effect.runPromise(
      maintenanceSweeps.sweepExpiredVendorClaims(NOW).pipe(Effect.provide(layer)),
    );
    expect(deleted).toBe(2);
    const left = db
      .select({ id: vendorClaims.id })
      .from(vendorClaims)
      .all()
      .map((r) => r.id)
      .toSorted();
    expect(left).toEqual(["vc_live", "vc_live_consumed"]);
  });
});

describe("maintenanceSweeps.sweepStalePreviews", () => {
  it("deletes stale previews + reaps their sheets; keeps fresh previews and applied rows", async () => {
    const { db, layer } = makeDb();
    const staleAt = NOW.getTime() - PREVIEW_STALE_AFTER_MS - 1000;
    seedImport(db, "imp_stale", "preview", staleAt);
    seedImport(db, "imp_fresh", "preview", NOW.getTime() - 1000);
    // Applied rows are the change history — never swept here, however old.
    seedImport(db, "imp_applied_old", "applied", staleAt);

    const reaped: string[] = [];
    const bucket: DeletableBucket = {
      delete: (keys) => {
        reaped.push(...(Array.isArray(keys) ? keys : [keys]));
      },
    };

    const deleted = await Effect.runPromise(
      maintenanceSweeps.sweepStalePreviews(NOW, { sheets: bucket }).pipe(Effect.provide(layer)),
    );
    expect(deleted).toBe(1);
    const left = db
      .select({ id: imports.id })
      .from(imports)
      .all()
      .map((r) => r.id)
      .toSorted();
    expect(left).toEqual(["imp_applied_old", "imp_fresh"]);
    expect(reaped.toSorted()).toEqual([
      "sheets/imp_stale/events.csv",
      "sheets/imp_stale/guests.csv",
    ]);
  });

  it("is a no-op with nothing stale", async () => {
    const { layer } = makeDb();
    const deleted = await Effect.runPromise(
      maintenanceSweeps.sweepStalePreviews(NOW).pipe(Effect.provide(layer)),
    );
    expect(deleted).toBe(0);
  });
});

describe("maintenanceSweeps — error channel", () => {
  // The cron handler catches MaintenanceSweepError via Effect.catchAll; a throw
  // that escaped as a defect would slip past it. These pin the typed mapping.
  const throwingDb = {
    delete: () => {
      throw new Error("boom: delete");
    },
    select: () => {
      throw new Error("boom: select");
    },
  } as unknown as Db;
  const throwingLayer = Layer.succeed(DbService, throwingDb);

  it("sweepExpiredVendorClaims fails with MaintenanceSweepError op=vendor_claims", async () => {
    const err = await Effect.runPromise(
      Effect.flip(
        maintenanceSweeps.sweepExpiredVendorClaims(NOW).pipe(Effect.provide(throwingLayer)),
      ),
    );
    expect(err._tag).toBe("MaintenanceSweepError");
    expect(err.op).toBe("vendor_claims");
    expect(err.reason).toContain("boom: delete");
  });

  it("sweepStalePreviews fails with MaintenanceSweepError op=stale_previews", async () => {
    const err = await Effect.runPromise(
      Effect.flip(maintenanceSweeps.sweepStalePreviews(NOW).pipe(Effect.provide(throwingLayer))),
    );
    expect(err._tag).toBe("MaintenanceSweepError");
    expect(err.op).toBe("stale_previews");
    expect(err.reason).toContain("boom: select");
  });
});
