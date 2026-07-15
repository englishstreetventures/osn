import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guests, imports, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../db";
import { createDb, seedBootstrapWedding } from "../db/setup";
import type { ParsedFamily } from "../schemas/import";
import { captureBeforeImage } from "./checkpoint";
import { applyImport, diffAgainstDb } from "./import";
import { R2Service, createR2Stub, storeUpload } from "./r2-imports";
import { revertImport, NoPriorImport } from "./revert";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";

const EVENTS_V1 = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
  "Wedding Ceremony,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,Formal,,,",
].join("\n");

const GUESTS_V1 = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
  "1,Testfamily,Ada,Testfamily,yes,yes",
].join("\n");

const EVENTS_V2 = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
  "Wedding Ceremony,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,Formal,,,",
  "Reception,2026-09-20T19:00:00+10:00,2026-09-21T00:00:00+10:00,Australia/Sydney,Doltone,,,,,",
].join("\n");

const GUESTS_V2 = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony,Reception",
  "1,Testfamily,Ada,Testfamily,yes,yes,yes",
  "2,Sampleton,Bo,Sampleton,no,yes,yes",
].join("\n");

async function applyVersion(
  layer: Layer.Layer<DbService | R2Service>,
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
      const summary = yield* applyImport(importId, plan, BOOTSTRAP_WEDDING_ID);
      const db = yield* DbService;
      db.insert(imports)
        .values({
          id: importId,
          weddingId: BOOTSTRAP_WEDDING_ID,
          uploadedAt,
          format: "csv",
          eventsR2Key: `imports/${importId}/events.csv`,
          guestsR2Key: `imports/${importId}/guests.csv`,
          summary: JSON.stringify(summary),
          status: "applied",
          appliedAt: uploadedAt,
        })
        .run();
    }).pipe(Effect.provide(layer)),
  );
}

/**
 * Apply an import the way the /apply route does under E3: capture the
 * full-fidelity before-image FIRST, apply, then record the before-keys on the
 * change row. Revert then uses the before-image path.
 */
async function applyWithBeforeImage(
  layer: Layer.Layer<DbService | R2Service>,
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
      const summary = yield* applyImport(importId, plan, BOOTSTRAP_WEDDING_ID);
      const db = yield* DbService;
      db.insert(imports)
        .values({
          id: importId,
          weddingId: BOOTSTRAP_WEDDING_ID,
          uploadedAt,
          format: "csv",
          eventsR2Key: `imports/${importId}/events.csv`,
          guestsR2Key: `imports/${importId}/guests.csv`,
          summary: JSON.stringify(summary),
          status: "applied",
          appliedAt: uploadedAt,
          beforeEventsR2Key: before.eventsKey,
          beforeGuestsR2Key: before.guestsKey,
        })
        .run();
    }).pipe(Effect.provide(layer)),
  );
}

describe("revertImport — before-image path (E3)", () => {
  it("restores the exact pre-change state after an interleaved change", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const r2 = createR2Stub();
    const layer = Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2));

    // Change 1: v1 (1 event set, 1 family). Change 2: v2 (adds Reception + Sampleton).
    await applyWithBeforeImage(layer, "chg-1", EVENTS_V1, GUESTS_V1, 1_000);
    await applyWithBeforeImage(layer, "chg-2", EVENTS_V2, GUESTS_V2, 2_000);

    expect(db.select().from(events).all()).toHaveLength(3);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);

    // Reverting change 2 restores change 2's before-image = the post-change-1
    // state (2 events, 1 family, 1 guest) — regardless of what interleaved.
    await Effect.runPromise(
      revertImport("chg-2", BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(guests).all()).toHaveLength(1);

    const [imp2] = db.select().from(imports).where(eq(imports.id, "chg-2")).all();
    expect(imp2!.status).toBe("reverted");
    expect(imp2!.revertedAt).not.toBeNull();
  });

  it("preserves claim codes + ids across a revert (rename-proof, no re-mint)", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const r2 = createR2Stub();
    const layer = Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2));

    await applyWithBeforeImage(layer, "chg-1", EVENTS_V1, GUESTS_V1, 1_000);
    const [famBefore] = db
      .select({ id: families.id, publicId: families.publicId, name: families.familyName })
      .from(families)
      .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
      .all();
    const [guestBefore] = db.select().from(guests).all();

    // Change 2 is an EVENT-only change (adds Reception) — it leaves the household
    // row (and its id/code) intact. Change 2's before-image is the full-fidelity
    // snapshot of the post-change-1 state (original id + code + name), so the
    // revert diff matches the still-present household BY ID (rename-proof) and
    // updates it back in place rather than remove+create.
    await applyWithBeforeImage(layer, "chg-2", EVENTS_V2, GUESTS_V1, 2_000);

    // Revert change 2 → the household is back with its EXACT original id + code,
    // and the extra event is gone.
    await Effect.runPromise(
      revertImport("chg-2", BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    const [famAfter] = db
      .select({ id: families.id, publicId: families.publicId, name: families.familyName })
      .from(families)
      .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
      .all();
    const [guestAfter] = db.select().from(guests).all();

    expect(famAfter!.id).toBe(famBefore!.id); // id preserved (id-matched update)
    expect(famAfter!.publicId).toBe(famBefore!.publicId); // code preserved (no re-mint)
    expect(famAfter!.name).toBe(famBefore!.name); // name unchanged
    expect(guestAfter!.id).toBe(guestBefore!.id); // guest id preserved
    expect(db.select().from(events).all()).toHaveLength(2); // Reception removed
  });

  it("preserves the claim code even when the change hard-recreated the household", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const r2 = createR2Stub();
    const layer = Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2));

    await applyWithBeforeImage(layer, "chg-1", EVENTS_V1, GUESTS_V1, 1_000);
    const [famBefore] = db
      .select({ publicId: families.publicId })
      .from(families)
      .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
      .all();

    // A standard-fidelity rename (no Family Code marker) → change 2 does
    // remove+create, rotating the household's internal id. Its before-image is
    // still full-fidelity, so reverting RESTORES the original claim code
    // (carried through the `Family Code` column) even though the row itself was
    // destroyed and re-made — the guest-facing invite code survives.
    const GUESTS_RENAMED = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
      "1,RenamedFamily,Ada,RenamedFamily,yes,yes",
    ].join("\n");
    await applyWithBeforeImage(layer, "chg-2", EVENTS_V1, GUESTS_RENAMED, 2_000);

    await Effect.runPromise(
      revertImport("chg-2", BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    const [famAfter] = db
      .select({ publicId: families.publicId, name: families.familyName })
      .from(families)
      .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
      .all();
    expect(famAfter!.publicId).toBe(famBefore!.publicId); // code preserved (no re-mint)
    expect(famAfter!.name).toBe("Testfamily"); // original name restored
  });
});

describe("revertImport", () => {
  it("reverts to the prior applied import's state", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const r2 = createR2Stub();
    const layer = Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2));

    await applyVersion(layer, "imp-1", EVENTS_V1, GUESTS_V1, 1_000);
    await applyVersion(layer, "imp-2", EVENTS_V2, GUESTS_V2, 2_000);

    expect(db.select().from(events).all()).toHaveLength(3);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);

    await Effect.runPromise(
      revertImport("imp-2", BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // Back to v1 state: 2 events, 1 family, 1 guest.
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(guests).all()).toHaveLength(1);

    const [imp2] = db.select().from(imports).where(eq(imports.id, "imp-2")).all();
    expect(imp2!.status).toBe("reverted");
    expect(imp2!.revertedAt).not.toBeNull();
  });

  it("fails with NoPriorImport when there's nothing earlier to roll back to", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const r2 = createR2Stub();
    const layer = Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2));

    await applyVersion(layer, "imp-only", EVENTS_V1, GUESTS_V1, 1_000);

    const error = await Effect.runPromise(
      Effect.flip(revertImport("imp-only", BOOTSTRAP_WEDDING_ID)).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(NoPriorImport);
  });

  it("refuses to revert an import that belongs to another wedding (T-S3)", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);

    // A second wedding owns an applied import. The bootstrap-scoped current-row
    // lookup filters by wedding_id, so a foreign import is indistinguishable
    // from a missing one → NoPriorImport (matching the /apply route's 404).
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_other",
        slug: "other",
        displayName: "Other",
        ownerOsnProfileId: "usr_other",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(imports)
      .values({
        id: "imp-foreign",
        weddingId: "wed_other",
        uploadedAt: 1_000,
        format: "csv",
        eventsR2Key: "imports/imp-foreign/events.csv",
        guestsR2Key: "imports/imp-foreign/guests.csv",
        summary: "{}",
        status: "applied",
        appliedAt: 1_000,
      })
      .run();

    const r2 = createR2Stub();
    const layer = Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2));

    const error = await Effect.runPromise(
      Effect.flip(revertImport("imp-foreign", BOOTSTRAP_WEDDING_ID)).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(NoPriorImport);
  });
});
