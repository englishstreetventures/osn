import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, guests, imports } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../db";
import { createDb, seedBootstrapWedding } from "../db/setup";
import type { ParsedFamily } from "../schemas/import";
import { BEFORE_IMAGE_RETENTION, captureBeforeImage, pruneBeforeImages } from "./checkpoint";
import { applyImport, diffAgainstDb } from "./import";
import { R2Service, createR2Stub, storeUpload } from "./r2-imports";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";

const EVENTS = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
].join("\n");

const GUESTS = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi",
  "1,Testfamily,Ada,Testfamily,yes",
].join("\n");

type TestLayer = Layer.Layer<DbService | R2Service>;

function makeLayer(): {
  db: ReturnType<typeof createDb>;
  r2: ReturnType<typeof createR2Stub>;
  layer: TestLayer;
} {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const r2 = createR2Stub();
  const layer = Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2));
  return { db, r2, layer };
}

/**
 * Mirror the /apply route: import an upload, then (as apply does) capture the
 * before-image, apply the plan, record the before-keys on the row, and prune.
 */
async function applyWithCheckpoint(
  db: ReturnType<typeof createDb>,
  r2: ReturnType<typeof createR2Stub>,
  layer: TestLayer,
  importId: string,
  eventsCsv: string,
  guestsCsv: string,
  uploadedAt: number,
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* storeUpload(eventsCsv, guestsCsv, importId);
      const ev = yield* parseEventsCsv(eventsCsv);
      const fam = (yield* parseGuestsCsv(guestsCsv, ev)) as ParsedFamily[];
      const plan = yield* diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID);

      const before = yield* captureBeforeImage(importId, BOOTSTRAP_WEDDING_ID);
      yield* applyImport(importId, plan, BOOTSTRAP_WEDDING_ID);
      const database = yield* DbService;
      database
        .insert(imports)
        .values({
          id: importId,
          weddingId: BOOTSTRAP_WEDDING_ID,
          uploadedAt,
          format: "csv",
          eventsR2Key: `imports/${importId}/events.csv`,
          guestsR2Key: `imports/${importId}/guests.csv`,
          summary: "{}",
          status: "applied",
          appliedAt: uploadedAt,
          beforeEventsR2Key: before.eventsKey,
          beforeGuestsR2Key: before.guestsKey,
        })
        .run();
      yield* pruneBeforeImages(BOOTSTRAP_WEDDING_ID, r2);
    }).pipe(Effect.provide(layer)),
  );
}

describe("captureBeforeImage", () => {
  it("stores the current state at full fidelity under the before/ prefix", async () => {
    const { db, r2, layer } = makeLayer();
    // Seed one family so the snapshot is non-trivial.
    await applyWithCheckpoint(db, r2, layer, "imp-1", EVENTS, GUESTS, 1_000);

    // A second apply captures the state left by the first — its before-image
    // must contain the family's live claim code (full fidelity).
    const [fam] = db
      .select({ publicId: families.publicId })
      .from(families)
      .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
      .all();
    await applyWithCheckpoint(db, r2, layer, "imp-2", EVENTS, GUESTS, 2_000);

    const beforeGuests = r2._store.get("imports/imp-2/before/guests.csv")!;
    expect(beforeGuests).toBeDefined();
    // Full fidelity: Family Code + Guest ID columns present, live code included.
    expect(beforeGuests.split("\r\n")[0]!.endsWith(",Family Code,Guest ID")).toBe(true);
    expect(beforeGuests).toContain(fam!.publicId);
  });

  it("records the before-keys on the change row", async () => {
    const { db, r2, layer } = makeLayer();
    await applyWithCheckpoint(db, r2, layer, "imp-1", EVENTS, GUESTS, 1_000);
    const [row] = db.select().from(imports).where(eq(imports.id, "imp-1")).all();
    expect(row!.beforeEventsR2Key).toBe("imports/imp-1/before/events.csv");
    expect(row!.beforeGuestsR2Key).toBe("imports/imp-1/before/guests.csv");
    expect(row!.kind).toBe("import"); // default backfill for the import path
  });
});

describe("pruneBeforeImages", () => {
  it(`keeps exactly the ${BEFORE_IMAGE_RETENTION} most-recent before-images and reaps the rest`, async () => {
    const { db, r2, layer } = makeLayer();

    // 13 applied changes → 3 should be pruned (10 kept).
    const total = BEFORE_IMAGE_RETENTION + 3;
    for (let i = 1; i <= total; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential apply is the scenario
      await applyWithCheckpoint(db, r2, layer, `imp-${i}`, EVENTS, GUESTS, i * 1_000);
    }

    const rows = db.select().from(imports).where(eq(imports.weddingId, BOOTSTRAP_WEDDING_ID)).all();
    const withImage = rows.filter((r) => r.beforeEventsR2Key !== null);
    // Exactly 10 rows keep a before-image.
    expect(withImage).toHaveLength(BEFORE_IMAGE_RETENTION);
    // ALL history rows survive (only R2 images age out).
    expect(rows).toHaveLength(total);

    // The 3 oldest lost their before-image (row survives, keys NULLed).
    const oldest = rows.toSorted((a, b) => a.uploadedAt - b.uploadedAt).slice(0, 3);
    for (const r of oldest) {
      expect(r.beforeEventsR2Key).toBeNull();
      expect(r.beforeGuestsR2Key).toBeNull();
    }

    // Their R2 objects were reaped.
    for (let i = 1; i <= 3; i++) {
      expect(r2._store.get(`imports/imp-${i}/before/events.csv`)).toBeUndefined();
      expect(r2._store.get(`imports/imp-${i}/before/guests.csv`)).toBeUndefined();
    }
    // A kept one is still present.
    expect(r2._store.get(`imports/imp-${total}/before/events.csv`)).toBeDefined();
  });

  it("is a no-op under the retention cap", async () => {
    const { db, r2, layer } = makeLayer();
    await applyWithCheckpoint(db, r2, layer, "imp-1", EVENTS, GUESTS, 1_000);
    const [row] = db.select().from(imports).where(eq(imports.id, "imp-1")).all();
    expect(row!.beforeEventsR2Key).not.toBeNull();
  });

  it("NULLs the keys even when the R2 bucket binding is absent (orphaned)", async () => {
    const { db, r2, layer } = makeLayer();
    const total = BEFORE_IMAGE_RETENTION + 1;
    for (let i = 1; i <= total; i++) {
      // eslint-disable-next-line no-await-in-loop
      await applyWithCheckpoint(db, r2, layer, `imp-${i}`, EVENTS, GUESTS, i * 1_000);
    }
    // Force a prune with no bucket — should still NULL the stale row's keys.
    await Effect.runPromise(
      pruneBeforeImages(BOOTSTRAP_WEDDING_ID, undefined).pipe(Effect.provide(layer)),
    );
    const [oldest] = db.select().from(imports).where(eq(imports.id, "imp-1")).all();
    expect(oldest!.beforeEventsR2Key).toBeNull();
    expect(db.select().from(guests).all().length).toBeGreaterThan(0); // data untouched
  });
});
