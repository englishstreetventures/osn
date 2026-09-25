import { describe, it, expect } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guestEvents,
  guests,
  imports,
  weddings,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { ParsedFamily } from "../../src/schemas/import";
import { decodeChangeBody } from "../../src/services/changes";
import { captureBeforeImage } from "../../src/services/checkpoint";
import { applyImport, diffAgainstDb } from "../../src/services/import";
import { R2Service, createR2Stub, storeUpload } from "../../src/services/r2-imports";
import {
  revertImport,
  storedRevertScope,
  translateAttendance,
  NoPriorImport,
  RevertParseError,
} from "../../src/services/revert";
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
 * Apply an import the way the /apply route does: capture the full-fidelity
 * before-image FIRST, apply, then record the before-keys on the change row.
 * Revert then uses the before-image path.
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

// ── Scope-aware before-image restore ────────────────────────────────────────

/**
 * Apply a change the way the /changes routes do: decode the body (either front
 * door), diff it with the options the route uses, capture the before-image, apply,
 * and store a change row whose summary carries the change's `scope`. Revert reads
 * that scope back, so a helper that stored no scope would run every "scoped" test
 * as a two-half restore.
 */
async function applyChange(
  layer: Layer.Layer<DbService | R2Service>,
  changeId: string,
  body: object,
  uploadedAt: number,
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const decoded = yield* decodeChangeBody(body, BOOTSTRAP_WEDDING_ID);
      const plan = yield* diffAgainstDb(
        decoded.desiredState.events,
        decoded.desiredState.families as ParsedFamily[],
        BOOTSTRAP_WEDDING_ID,
        {
          removeManual: decoded.removeManual,
          scope: decoded.scope,
          matchByName: decoded.matchByName,
        },
      );
      yield* storeUpload(
        decoded.uploadedCsv?.eventsCsv ?? JSON.stringify(decoded.desiredState),
        decoded.uploadedCsv?.guestsCsv ?? "",
        changeId,
      );
      const before = yield* captureBeforeImage(changeId, BOOTSTRAP_WEDDING_ID);
      yield* applyImport(changeId, plan, BOOTSTRAP_WEDDING_ID);
      const db = yield* DbService;
      db.insert(imports)
        .values({
          id: changeId,
          weddingId: BOOTSTRAP_WEDDING_ID,
          uploadedAt,
          format: "csv",
          kind: decoded.kind,
          eventsR2Key: `imports/${changeId}/events.csv`,
          guestsR2Key: `imports/${changeId}/guests.csv`,
          summary: JSON.stringify({
            baseRevision: "test",
            removeManual: decoded.removeManual,
            matchByName: decoded.matchByName,
            scope: decoded.scope,
          }),
          status: "applied",
          appliedAt: uploadedAt,
          beforeEventsR2Key: before.eventsKey,
          beforeGuestsR2Key: before.guestsKey,
        })
        .run();
    }).pipe(Effect.provide(layer)),
  );
}

function scopedLayer() {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const r2 = createR2Stub();
  return { db, r2, layer: Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2)) };
}

function revert(layer: Layer.Layer<DbService | R2Service>, changeId: string) {
  return Effect.runPromise(
    revertImport(changeId, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
  );
}

type TestDb = ReturnType<typeof createDb>;

/** The names of the events a guest is invited to, sorted. */
function invitesOf(db: TestDb, guestId: string): string[] {
  return db
    .select({ name: events.name })
    .from(guestEvents)
    .innerJoin(events, eq(guestEvents.eventId, events.id))
    .where(eq(guestEvents.guestId, guestId))
    .all()
    .map((r) => r.name)
    .toSorted();
}

function guestNamed(db: TestDb, firstName: string) {
  return db.select().from(guests).where(eq(guests.firstName, firstName)).all()[0];
}

function familyNamed(db: TestDb, familyName: string) {
  return db.select().from(families).where(eq(families.familyName, familyName)).all()[0];
}

/** Two households, three events: Ada everywhere, Bo at the ceremony and reception. */
const SEED = { eventsCsv: EVENTS_V2, guestsCsv: GUESTS_V2 };

describe("storedRevertScope", () => {
  it("reads the scope stored on the change row", () => {
    expect(storedRevertScope('{"scope":"events"}')).toBe("events");
    expect(storedRevertScope('{"scope":"guests","baseRevision":"x"}')).toBe("guests");
    expect(storedRevertScope('{"scope":"both"}')).toBe("both");
  });

  it("restores both halves when the row has no readable scope", () => {
    expect(storedRevertScope("{}")).toBe("both");
    expect(storedRevertScope('{"scope":"sideways"}')).toBe("both");
    expect(storedRevertScope('{"scope":null}')).toBe("both");
    expect(storedRevertScope("not json")).toBe("both");
    expect(storedRevertScope("[]")).toBe("both");
  });
});

describe("revertImport — an events-scoped change restores the schedule only", () => {
  it("leaves guest edits made after it untouched and re-invites guests to the event it brings back", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    const ada = guestNamed(db, "Ada")!;
    const bo = guestNamed(db, "Bo")!;

    // c1 deletes the reception (its invitations go with it).
    await applyChange(layer, "c1", { eventsCsv: EVENTS_V1 }, 2_000);
    // c2, later, edits the guest half: Bo's surname, Bo invited to the mehndi,
    // and a new guest Cy.
    await applyChange(
      layer,
      "c2",
      {
        guestsCsv: [
          "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
          "1,Testfamily,Ada,Testfamily,yes,yes",
          "2,Sampleton,Bo,Renamed,yes,yes",
          "2,Sampleton,Cy,Sampleton,no,yes",
        ].join("\n"),
      },
      3_000,
    );

    const summary = await revert(layer, "c1");

    // The schedule is back…
    expect(
      db
        .select()
        .from(events)
        .all()
        .map((e) => e.name)
        .toSorted(),
    ).toEqual(["Mehndi", "Reception", "Wedding Ceremony"].toSorted());
    // …the guests who were invited to the reception and still exist are invited
    // again, and c2's guest edits all stand.
    expect(invitesOf(db, ada.id)).toEqual(["Mehndi", "Reception", "Wedding Ceremony"].toSorted());
    expect(invitesOf(db, bo.id)).toEqual(["Mehndi", "Reception", "Wedding Ceremony"].toSorted());
    expect(guestNamed(db, "Bo")!.lastName).toBe("Renamed");
    expect(invitesOf(db, guestNamed(db, "Cy")!.id)).toEqual(["Wedding Ceremony"]);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(3);
    expect(summary).toMatchObject({
      familiesCreated: 0,
      familiesUpdated: 0,
      familiesRemoved: 0,
      guestsCreated: 0,
      guestsUpdated: 0,
      guestsRemoved: 0,
    });
    const [row] = db.select().from(imports).where(eq(imports.id, "c1")).all();
    expect(row!.status).toBe("reverted");
  });

  it("re-invites only guests that still exist", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    await applyChange(layer, "c1", { eventsCsv: EVENTS_V1 }, 2_000);
    // Bo's household is deleted after the reception was.
    await applyChange(
      layer,
      "c2",
      {
        guestsCsv: [
          "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
          "1,Testfamily,Ada,Testfamily,yes,yes",
        ].join("\n"),
      },
      3_000,
    );

    await revert(layer, "c1");

    const reception = db.select().from(events).where(eq(events.name, "Reception")).all()[0]!;
    const invited = db
      .select({ guestId: guestEvents.guestId })
      .from(guestEvents)
      .where(eq(guestEvents.eventId, reception.id))
      .all();
    expect(invited).toEqual([{ guestId: guestNamed(db, "Ada")!.id }]);
    expect(db.select().from(guests).all()).toHaveLength(1);
    expect(db.select().from(families).all()).toHaveLength(1);
  });

  it("re-invites a guest whose stored first name is blank", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    const bo = guestNamed(db, "Bo")!;
    // The editor door does not refuse a blank first name, so the snapshot has to
    // read one back rather than fail the revert over the half it is not restoring.
    db.update(guests).set({ firstName: "" }).where(eq(guests.id, bo.id)).run();
    await applyChange(layer, "c1", { eventsCsv: EVENTS_V1 }, 2_000);

    await revert(layer, "c1");

    expect(invitesOf(db, bo.id)).toEqual(["Reception", "Wedding Ceremony"].toSorted());
  });

  it("removes an event added since, with its invitations, and no household or guest", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", { eventsCsv: EVENTS_V1, guestsCsv: GUESTS_V1 }, 1_000);
    const ada = guestNamed(db, "Ada")!;
    // c1 adds the reception; c2 invites Ada to it.
    await applyChange(layer, "c1", { eventsCsv: EVENTS_V2 }, 2_000);
    await applyChange(
      layer,
      "c2",
      {
        guestsCsv: [
          "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony,Reception",
          "1,Testfamily,Ada,Testfamily,yes,yes,yes",
        ].join("\n"),
      },
      3_000,
    );
    expect(invitesOf(db, ada.id)).toContain("Reception");

    const summary = await revert(layer, "c1");

    expect(db.select().from(events).all()).toHaveLength(2);
    expect(invitesOf(db, ada.id)).toEqual(["Mehndi", "Wedding Ceremony"].toSorted());
    expect(guestNamed(db, "Ada")!.id).toBe(ada.id);
    expect(summary.eventsRemoved).toBe(1);
    expect(summary.guestsRemoved).toBe(0);
  });
});

describe("revertImport — a guests-scoped change restores the guest half only", () => {
  const WITHOUT_SAMPLETON = {
    guestsCsv: [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony,Reception",
      "1,Testfamily,Ada,Testfamily,yes,yes,yes",
    ].join("\n"),
  };

  /** A full-fidelity events sheet of the live schedule with one event renamed —
   *  an id-matched rename, as the events editor makes it. */
  async function renameEvent(
    layer: Layer.Layer<DbService | R2Service>,
    from: string,
    to: string,
  ): Promise<string> {
    const csv = await Effect.runPromise(
      stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, "full").pipe(Effect.provide(layer)),
    );
    return csv.replace(`\r\n${from},`, `\r\n${to},`);
  }

  it("brings back households, guests and invitations and leaves a later event rename alone", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    const sampleton = familyNamed(db, "Sampleton")!;
    const ada = guestNamed(db, "Ada")!;
    await applyChange(layer, "c1", WITHOUT_SAMPLETON, 2_000);
    expect(familyNamed(db, "Sampleton")).toBeUndefined();

    // Later, the ceremony is renamed in place.
    const renamed = await renameEvent(layer, "Wedding Ceremony", "Ceremony");
    await applyChange(layer, "c2", { eventsCsv: renamed }, 3_000);

    await revert(layer, "c1");

    // The household is back with its invite code; Bo's invitation to the renamed
    // event was translated through its Event ID rather than dropped.
    expect(familyNamed(db, "Sampleton")!.publicId).toBe(sampleton.publicId);
    expect(invitesOf(db, guestNamed(db, "Bo")!.id)).toEqual(["Ceremony", "Reception"]);
    expect(invitesOf(db, ada.id)).toEqual(["Ceremony", "Mehndi", "Reception"]);
    // The schedule is as c2 left it.
    expect(
      db
        .select()
        .from(events)
        .all()
        .map((e) => e.name)
        .toSorted(),
    ).toEqual(["Ceremony", "Mehndi", "Reception"]);
  });

  it("drops invitations to an event deleted since, and still succeeds", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    await applyChange(layer, "c1", WITHOUT_SAMPLETON, 2_000);
    await applyChange(layer, "c2", { eventsCsv: EVENTS_V1 }, 3_000);

    await revert(layer, "c1");

    expect(invitesOf(db, guestNamed(db, "Bo")!.id)).toEqual(["Wedding Ceremony"]);
    expect(db.select().from(events).all()).toHaveLength(2);
  });

  it("keeps invitations to an event created since the checkpoint", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", { eventsCsv: EVENTS_V1, guestsCsv: GUESTS_V1 }, 1_000);
    const ada = guestNamed(db, "Ada")!;
    // c1 adds Bo's household.
    await applyChange(
      layer,
      "c1",
      {
        guestsCsv: [
          "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
          "1,Testfamily,Ada,Testfamily,yes,yes",
          "2,Sampleton,Bo,Sampleton,no,yes",
        ].join("\n"),
      },
      2_000,
    );
    // Later: a reception is added, and both guests are invited to it.
    await applyChange(layer, "c2", { eventsCsv: EVENTS_V2 }, 3_000);
    await applyChange(
      layer,
      "c3",
      {
        guestsCsv: [
          "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony,Reception",
          "1,Testfamily,Ada,Testfamily,yes,yes,yes",
          "2,Sampleton,Bo,Sampleton,no,yes,yes",
        ].join("\n"),
      },
      4_000,
    );

    await revert(layer, "c1");

    // Bo's household did not exist before c1, so it goes. The snapshot says
    // nothing about the reception — it did not exist then — so Ada keeps it.
    expect(familyNamed(db, "Sampleton")).toBeUndefined();
    expect(invitesOf(db, ada.id)).toEqual(["Mehndi", "Reception", "Wedding Ceremony"].toSorted());
  });

  it("does not run the upload guards over the events sheet it is not restoring", async () => {
    const { db, r2, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    // Values the events editor can store but an uploaded sheet may not carry: a
    // fixed-offset zone and a description over the upload cell cap.
    db.update(events)
      .set({ timezone: "UTC+10", dressCodeDescription: "x".repeat(10_050) })
      .where(eq(events.name, "Mehndi"))
      .run();
    await applyChange(layer, "c1", WITHOUT_SAMPLETON, 2_000);

    // The stored events snapshot really would fail the upload parser…
    const [row] = db.select().from(imports).where(eq(imports.id, "c1")).all();
    const stored = await (await r2.get(row!.beforeEventsR2Key!))!.text();
    const parsed = await Effect.runPromise(Effect.exit(parseEventsCsv(stored)));
    expect(parsed._tag).toBe("Failure");

    // …and the guests revert still succeeds.
    await revert(layer, "c1");
    expect(invitesOf(db, guestNamed(db, "Bo")!.id)).toEqual(
      ["Reception", "Wedding Ceremony"].toSorted(),
    );
  });
});

describe("revertImport — guest-less households survive a restore", () => {
  function addGuestlessHousehold(db: TestDb, id: string, familyName: string, publicId: string) {
    const now = new Date();
    db.insert(families)
      .values({
        id,
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId,
        familyName,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  /** An editor draft of the whole wedding as it stands, with every id. */
  async function draftOf(layer: Layer.Layer<DbService | R2Service>) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const ev = yield* parseEventsCsv(
          yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, "snapshot"),
        );
        const fam = yield* parseGuestsCsv(
          yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, "snapshot"),
          ev,
          { snapshot: true },
        );
        return { events: ev, families: fam };
      }).pipe(Effect.provide(layer)),
    );
  }

  it("brings back a guest-less household a guests change removed, with its code", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    addGuestlessHousehold(db, "fam_empty", "Emptyhouse", "EMPTY-0001");
    // A guests sheet cannot list a household with no guests, so this upload
    // removes it.
    await applyChange(layer, "c1", { guestsCsv: GUESTS_V2 }, 2_000);
    expect(familyNamed(db, "Emptyhouse")).toBeUndefined();

    await revert(layer, "c1");

    // Re-created, so a new row id — but the invite code it had.
    expect(familyNamed(db, "Emptyhouse")!.publicId).toBe("EMPTY-0001");
  });

  it("keeps a guest-less household that was there before and after the change", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    addGuestlessHousehold(db, "fam_empty", "Emptyhouse", "EMPTY-0001");
    // Two households of the same name: the guest-less one must not swallow the
    // populated one (or the other way round) on the way back.
    addGuestlessHousehold(db, "fam_same_name", "sampleton", "EMPTY-0002");
    const sampleton = familyNamed(db, "Sampleton")!;

    // An editor save of both halves that adds a guest and keeps every household.
    const draft = await draftOf(layer);
    const families_ = draft.families.map((f) =>
      f.familyName === "Testfamily"
        ? {
            ...f,
            guests: [
              ...f.guests,
              { firstName: "Cy", lastName: "", nickname: null, eventNames: [] },
            ],
          }
        : f,
    );
    await applyChange(
      layer,
      "c1",
      {
        desiredState: { events: draft.events, families: families_ },
        removeManual: true,
        baseRevision: "test",
      },
      2_000,
    );
    expect(guestNamed(db, "Cy")).toBeDefined();

    await revert(layer, "c1");

    expect(guestNamed(db, "Cy")).toBeUndefined();
    const byId = new Map(
      db
        .select()
        .from(families)
        .all()
        .map((f) => [f.id, f]),
    );
    expect(byId.get("fam_empty")!.publicId).toBe("EMPTY-0001");
    expect(byId.get("fam_same_name")!.publicId).toBe("EMPTY-0002");
    expect(byId.get(sampleton.id)!.publicId).toBe(sampleton.publicId);
    expect(guestNamed(db, "Bo")!.familyId).toBe(sampleton.id);
    expect(byId.size).toBe(4);
  });
});

describe("revertImport — legacy path honours a stored scope", () => {
  it("replays only the predecessor's sheet for the half the change saved", async () => {
    const { db, layer } = scopedLayer();
    await applyVersion(layer, "imp-1", EVENTS_V1, GUESTS_V1, 1_000);
    await applyVersion(layer, "imp-2", EVENTS_V2, GUESTS_V2, 2_000);
    db.update(imports)
      .set({ summary: JSON.stringify({ scope: "events" }) })
      .where(eq(imports.id, "imp-2"))
      .run();

    await revert(layer, "imp-2");

    // The schedule is imp-1's again; the guest half is untouched.
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(2);
  });

  it("fails with NoPriorImport when the predecessor did not carry that half", async () => {
    const { db, layer } = scopedLayer();
    await applyVersion(layer, "imp-1", EVENTS_V1, GUESTS_V1, 1_000);
    await applyPartialVersion(layer, "imp-p", { guestsCsv: GUESTS_V1, uploadedAt: 2_000 });
    await applyVersion(layer, "imp-3", EVENTS_V2, GUESTS_V2, 3_000);
    db.update(imports)
      .set({ summary: JSON.stringify({ scope: "events" }) })
      .where(eq(imports.id, "imp-3"))
      .run();

    const error = await Effect.runPromise(
      Effect.flip(revertImport("imp-3", BOOTSTRAP_WEDDING_ID)).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(NoPriorImport);
    expect(db.select().from(events).all()).toHaveLength(3);
  });
});

describe("translateAttendance", () => {
  const family = (eventNames: string[]): ParsedFamily => ({
    id: "fam_a",
    familyName: "Testfamily",
    guests: [{ id: "gst_a", firstName: "Ada", lastName: "", nickname: null, eventNames }],
  });
  const namesOf = (translated: readonly ParsedFamily[]) => translated[0]!.guests[0]!.eventNames;

  it("follows an event renamed since by its id", () => {
    const { families: out, knownEventIds } = translateAttendance(
      [family(["Wedding Ceremony"])],
      [{ name: "Wedding Ceremony", id: "evt_1" }],
      [{ id: "evt_1", name: "Ceremony" }],
    );
    expect(namesOf(out)).toEqual(["Ceremony"]);
    expect([...knownEventIds]).toEqual(["evt_1"]);
  });

  it("falls back to the name when the id is gone (deleted and re-created since)", () => {
    const { families: out, knownEventIds } = translateAttendance(
      [family(["Reception"])],
      [{ name: "Reception", id: "evt_old" }],
      [{ id: "evt_new", name: " reception " }],
    );
    expect(namesOf(out)).toEqual([" reception "]);
    expect([...knownEventIds]).toEqual(["evt_new"]);
  });

  it("matches by name when the snapshot carries no Event ID", () => {
    const { families: out } = translateAttendance(
      [family(["Mehndi"])],
      [{ name: "Mehndi", id: undefined }],
      [{ id: "evt_1", name: "Mehndi" }],
    );
    expect(namesOf(out)).toEqual(["Mehndi"]);
  });

  it("never lets a name fallback take a live event another snapshot event holds by id", () => {
    // "Lunch" (evt_2) was deleted; "Dinner" (evt_1) has since been renamed to
    // "Lunch". Lunch's invitations must not land on evt_1 beside Dinner's.
    const { families: out, knownEventIds } = translateAttendance(
      [family(["Dinner", "Lunch"])],
      [
        { name: "Dinner", id: "evt_1" },
        { name: "Lunch", id: "evt_2" },
      ],
      [{ id: "evt_1", name: "Lunch" }],
    );
    expect(namesOf(out)).toEqual(["Lunch"]);
    expect([...knownEventIds]).toEqual(["evt_1"]);
  });

  it("drops an invitation to an event that resolves to nothing, and leaves unknown live events out of knownEventIds", () => {
    const { families: out, knownEventIds } = translateAttendance(
      [family(["Mehndi", "Gone"])],
      [
        { name: "Mehndi", id: "evt_1" },
        { name: "Gone", id: "evt_gone" },
      ],
      [
        { id: "evt_1", name: "Mehndi" },
        { id: "evt_added_since", name: "Brunch" },
      ],
    );
    expect(namesOf(out)).toEqual(["Mehndi"]);
    expect([...knownEventIds]).toEqual(["evt_1"]);
  });
});

describe("revertImport — scoped edge cases", () => {
  it("does not invite anyone to an event re-created by hand before an events revert", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    await applyChange(layer, "c1", { eventsCsv: EVENTS_V1 }, 2_000);
    // The organiser adds a "Reception" again by hand, inviting nobody.
    await applyChange(layer, "c2", { eventsCsv: EVENTS_V2 }, 3_000);
    const reception = db.select().from(events).where(eq(events.name, "Reception")).all()[0]!;

    await revert(layer, "c1");

    // The diff matched the snapshot's reception to this one by name, so it is
    // not re-created and keeps the (empty) invitation list it has.
    expect(db.select().from(events).where(eq(events.name, "Reception")).all()[0]!.id).toBe(
      reception.id,
    );
    expect(
      db.select().from(guestEvents).where(eq(guestEvents.eventId, reception.id)).all(),
    ).toHaveLength(0);
  });

  it("fails before writing anything when a guests revert meets an events snapshot with no Event Name column", async () => {
    const { db, r2, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    await applyChange(layer, "c1", { guestsCsv: GUESTS_V1 }, 2_000);
    const [row] = db.select().from(imports).where(eq(imports.id, "c1")).all();
    await r2.put(row!.beforeEventsR2Key!, "Name,Start\r\nMehndi,2026-09-18T16:00");

    const error = await Effect.runPromise(
      Effect.flip(revertImport("c1", BOOTSTRAP_WEDDING_ID)).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(RevertParseError);
    expect((error as RevertParseError).reason).toContain("no Event Name column");
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(imports).where(eq(imports.id, "c1")).all()[0]!.status).toBe("applied");
  });

  it("fails before writing anything when a guests revert meets a guests snapshot it cannot read", async () => {
    const { db, r2, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    await applyChange(layer, "c1", { guestsCsv: GUESTS_V1 }, 2_000);
    const [row] = db.select().from(imports).where(eq(imports.id, "c1")).all();
    await r2.put(row!.beforeGuestsR2Key!, "Family Name,Guest First Name\r\nTestfamily,Ada");

    const error = await Effect.runPromise(
      Effect.flip(revertImport("c1", BOOTSTRAP_WEDDING_ID)).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(RevertParseError);
    expect((error as RevertParseError).reason).toBe("guests parse failed: MissingRequiredColumn");
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(imports).where(eq(imports.id, "c1")).all()[0]!.status).toBe("applied");
  });

  it("an events revert still reads its events through the upload parser, and fails cleanly on a value it refuses", async () => {
    const { db, layer } = scopedLayer();
    await applyChange(layer, "c0", SEED, 1_000);
    // A value the events editor can store but the parser refuses. The events
    // half is what this revert restores, so it cannot skip the value; it has
    // to fail without writing (englishstventures/osn#1220).
    db.update(events).set({ timezone: "UTC+10" }).where(eq(events.name, "Mehndi")).run();
    await applyChange(layer, "c1", { eventsCsv: EVENTS_V1 }, 2_000);

    const error = await Effect.runPromise(
      Effect.flip(revertImport("c1", BOOTSTRAP_WEDDING_ID)).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(RevertParseError);
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(imports).where(eq(imports.id, "c1")).all()[0]!.status).toBe("applied");
  });

  it("legacy path: a guests scope replays only the predecessor's guests sheet", async () => {
    const { db, layer } = scopedLayer();
    await applyVersion(layer, "imp-1", EVENTS_V1, GUESTS_V1, 1_000);
    await applyVersion(layer, "imp-2", EVENTS_V2, GUESTS_V2, 2_000);
    db.update(imports)
      .set({ summary: JSON.stringify({ scope: "guests" }) })
      .where(eq(imports.id, "imp-2"))
      .run();

    await revert(layer, "imp-2");

    // The guest half is imp-1's again; the schedule is untouched.
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(events).all()).toHaveLength(3);
  });

  it("legacy path: a guests scope with an events-only predecessor has nothing to restore", async () => {
    const { db, layer } = scopedLayer();
    await applyVersion(layer, "imp-1", EVENTS_V1, GUESTS_V1, 1_000);
    await applyPartialVersion(layer, "imp-p", { eventsCsv: EVENTS_V1, uploadedAt: 2_000 });
    await applyVersion(layer, "imp-3", EVENTS_V2, GUESTS_V2, 3_000);
    db.update(imports)
      .set({ summary: JSON.stringify({ scope: "guests" }) })
      .where(eq(imports.id, "imp-3"))
      .run();

    const error = await Effect.runPromise(
      Effect.flip(revertImport("imp-3", BOOTSTRAP_WEDDING_ID)).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(NoPriorImport);
    expect(db.select().from(families).all()).toHaveLength(2);
  });
});

describe("revertImport — reads only the sheets a scope needs", () => {
  it("an events revert that re-creates no event never fetches the guests sheet", async () => {
    const { db, r2, layer } = scopedLayer();
    await applyChange(layer, "c0", { eventsCsv: EVENTS_V1, guestsCsv: GUESTS_V1 }, 1_000);
    // c1 adds an event; reverting it only removes one, so nothing is re-created.
    await applyChange(layer, "c1", { eventsCsv: EVENTS_V2 }, 2_000);
    const [row] = db.select().from(imports).where(eq(imports.id, "c1")).all();
    await r2.delete(row!.beforeGuestsR2Key!);

    await revert(layer, "c1");

    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(imports).where(eq(imports.id, "c1")).all()[0]!.status).toBe("reverted");
  });
});
