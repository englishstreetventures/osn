import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guests, imports, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { ParsedFamily } from "../../src/schemas/import";
import { captureBeforeImage } from "../../src/services/checkpoint";
import { applyImport, diffAgainstDb } from "../../src/services/import";
import { R2Service, createR2Stub, storeUpload } from "../../src/services/r2-imports";
import { revertImport, NoPriorImport, RevertParseError } from "../../src/services/revert";
import { parseEventsCsv, parseGuestsCsv } from "../../src/services/spreadsheet";
import { stateExportService } from "../../src/services/state-export";

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

  it("restores a household's OLD NAME when reverting an in-place rename (familyUpdates path)", async () => {
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

    // Change 2 is an editor-style IN-PLACE rename: an id-carrying desired state
    // diffed with the editor's options, producing a familyUpdates-only plan —
    // the op this fix introduced. Before it existed the rename never applied,
    // so no revert could meaningfully exercise restoring FROM one.
    await Effect.runPromise(
      Effect.gen(function* () {
        const eventsCsv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, "full");
        const guestsCsv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, "full");
        const ev = yield* parseEventsCsv(eventsCsv);
        const fam = (yield* parseGuestsCsv(guestsCsv, ev)) as ParsedFamily[];
        const renamed = fam.map((f) => ({ ...f, familyName: "Renamed In Place" }));
        yield* storeUpload(JSON.stringify({ events: ev, families: renamed }), "", "chg-2");
        const before = yield* captureBeforeImage("chg-2", BOOTSTRAP_WEDDING_ID);
        const plan = yield* diffAgainstDb(ev, renamed, BOOTSTRAP_WEDDING_ID, {
          removeManual: true,
          matchByName: false,
        });
        const summary = yield* applyImport("chg-2", plan, BOOTSTRAP_WEDDING_ID);
        const dbs = yield* DbService;
        dbs
          .insert(imports)
          .values({
            id: "chg-2",
            weddingId: BOOTSTRAP_WEDDING_ID,
            uploadedAt: 2_000,
            format: "csv",
            eventsR2Key: "imports/chg-2/events.csv",
            guestsR2Key: "imports/chg-2/guests.csv",
            summary: JSON.stringify(summary),
            status: "applied",
            appliedAt: 2_000,
            kind: "editor",
            beforeEventsR2Key: before.eventsKey,
            beforeGuestsR2Key: before.guestsKey,
          })
          .run();
        return summary;
      }).pipe(Effect.provide(layer)),
    ).then((summary) => {
      // The rename applied in place — one family updated, nothing else touched.
      expect(summary.familiesUpdated).toBe(1);
      expect(summary.familiesCreated).toBe(0);
      expect(summary.familiesRemoved).toBe(0);
    });
    const [famRenamed] = db
      .select({ name: families.familyName })
      .from(families)
      .where(eq(families.id, famBefore!.id))
      .all();
    expect(famRenamed!.name).toBe("Renamed In Place");

    // Revert change 2 → the ORIGINAL name comes back in place: same row id,
    // same claim code, old name (the before-image is full-fidelity, so the
    // revert diff id-matches and emits the reverse familyUpdate).
    await Effect.runPromise(
      revertImport("chg-2", BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    const [famAfter] = db
      .select({ id: families.id, publicId: families.publicId, name: families.familyName })
      .from(families)
      .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
      .all();
    expect(famAfter!.name).toBe(famBefore!.name);
    expect(famAfter!.id).toBe(famBefore!.id);
    expect(famAfter!.publicId).toBe(famBefore!.publicId);
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

/**
 * Record an APPLIED spreadsheet row whose stored slots are exactly what a
 * single-sheet upload leaves behind: the uploaded sheet in one slot, `""` in the
 * other. No before-image, so a later revert falls onto the LEGACY path and
 * replays these bytes — the one place a blank slot is read back rather than
 * ignored via `scope`.
 */
async function applyPartialVersion(
  layer: Layer.Layer<DbService | R2Service>,
  importId: string,
  opts: { eventsCsv?: string; guestsCsv?: string; uploadedAt: number },
): Promise<void> {
  const eventsCsv = opts.eventsCsv ?? "";
  const guestsCsv = opts.guestsCsv ?? "";
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* storeUpload(eventsCsv, guestsCsv, importId);
      const db = yield* DbService;
      db.insert(imports)
        .values({
          id: importId,
          weddingId: BOOTSTRAP_WEDDING_ID,
          uploadedAt: opts.uploadedAt,
          format: "csv",
          eventsR2Key: `imports/${importId}/events.csv`,
          guestsR2Key: `imports/${importId}/guests.csv`,
          summary: "{}",
          status: "applied",
          appliedAt: opts.uploadedAt,
        })
        .run();
    }).pipe(Effect.provide(layer)),
  );
}

describe("revertImport — legacy path with a single-sheet predecessor", () => {
  function freshLayer() {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const r2 = createR2Stub();
    return { db, layer: Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2)) };
  }

  it("a blank GUESTS slot leaves every household standing (not reconciled to empty)", async () => {
    const { db, layer } = freshLayer();
    // v1 populates the wedding; the predecessor we revert TO is an events-only
    // upload, whose guests slot holds "".
    await applyVersion(layer, "imp-1", EVENTS_V1, GUESTS_V1, 1_000);
    await applyPartialVersion(layer, "imp-partial", { eventsCsv: EVENTS_V2, uploadedAt: 2_000 });
    await applyVersion(layer, "imp-3", EVENTS_V2, GUESTS_V2, 3_000);

    expect(db.select().from(families).all()).toHaveLength(2);

    await Effect.runPromise(
      revertImport("imp-3", BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // The predecessor's blank guests slot means "this half was not captured".
    // Reading it as an empty sheet would delete BOTH households here.
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);
    // The events half still reconciles from the slot that was captured.
    expect(db.select().from(events).all()).toHaveLength(3);
  });

  it("a blank EVENTS slot leaves the schedule standing", async () => {
    const { db, layer } = freshLayer();
    await applyVersion(layer, "imp-1", EVENTS_V2, GUESTS_V2, 1_000);
    await applyPartialVersion(layer, "imp-partial", { guestsCsv: GUESTS_V1, uploadedAt: 2_000 });
    await applyVersion(layer, "imp-3", EVENTS_V2, GUESTS_V2, 3_000);

    await Effect.runPromise(
      revertImport("imp-3", BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // Schedule untouched; the guests half reconciles back to the single household.
    expect(db.select().from(events).all()).toHaveLength(3);
    expect(db.select().from(families).all()).toHaveLength(1);
  });

  it("refuses a snapshot with neither sheet rather than reconciling to nothing", async () => {
    const { db, layer } = freshLayer();
    await applyVersion(layer, "imp-1", EVENTS_V1, GUESTS_V1, 1_000);
    await applyPartialVersion(layer, "imp-empty", { uploadedAt: 2_000 });
    await applyVersion(layer, "imp-3", EVENTS_V2, GUESTS_V2, 3_000);

    const error = await Effect.runPromise(
      Effect.flip(revertImport("imp-3", BOOTSTRAP_WEDDING_ID)).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(RevertParseError);
    expect((error as RevertParseError).reason).toContain("neither sheet");
    // And nothing was destroyed on the way to that refusal.
    expect(db.select().from(events).all()).toHaveLength(3);
    expect(db.select().from(families).all()).toHaveLength(2);
  });

  it("skips an EDITOR row as the legacy predecessor (its slot holds JSON, not CSV)", async () => {
    const { db, layer } = freshLayer();
    await applyVersion(layer, "imp-1", EVENTS_V1, GUESTS_V1, 1_000);

    // An editor save: DesiredState JSON in the events slot, "" in the guests
    // slot. Byte-wise that looks exactly like an events-only upload, so without
    // the kind filter the blank-half inference would feed JSON to the CSV parser.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeUpload(JSON.stringify({ events: [], families: [] }), "", "imp-editor");
        const dbs = yield* DbService;
        dbs
          .insert(imports)
          .values({
            id: "imp-editor",
            weddingId: BOOTSTRAP_WEDDING_ID,
            uploadedAt: 2_000,
            format: "csv",
            eventsR2Key: "imports/imp-editor/events.csv",
            guestsR2Key: "imports/imp-editor/guests.csv",
            summary: "{}",
            status: "applied",
            appliedAt: 2_000,
            kind: "editor",
          })
          .run();
      }).pipe(Effect.provide(layer)),
    );

    await applyVersion(layer, "imp-3", EVENTS_V2, GUESTS_V2, 3_000);

    await Effect.runPromise(
      revertImport("imp-3", BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // It rolled back to imp-1 (the newest *import* row), not to the editor row.
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(1);
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
