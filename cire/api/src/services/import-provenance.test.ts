import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, guests } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedBootstrapWedding } from "../db/setup";
import type { ParsedEvent, ParsedFamily } from "../schemas/import";
import { applyImport, diffAgainstDb } from "./import";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";

// A wedding populated by a first CSV import (all rows land source='import'),
// then augmented with a hand-added (source='manual') household + a hand-added
// guest inside an imported household — the state E4's provenance filter must
// respect on a subsequent CSV re-import.

const EVENTS_CSV = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-11-22T18:00:00+11:00,2026-11-22T23:00:00+11:00,Australia/Sydney,,,,,,",
  "Reception,2026-11-28T18:00:00+11:00,2026-11-28T23:00:00+11:00,Australia/Sydney,,,,,,",
].join("\n");

// The import sheet contains ONLY the imported household — the manual household
// and the manual guest are deliberately absent (they were never in a sheet).
const GUESTS_CSV = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
  "1,Importfamily,Ada,Importfamily,yes,yes",
  "2,Importfamily,Bo,Importfamily,no,yes",
].join("\n");

async function seededWedding(): Promise<Db> {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const layer = Layer.succeed(DbService, db);
  await Effect.runPromise(
    Effect.gen(function* () {
      const ev = yield* parseEventsCsv(EVENTS_CSV);
      const fam = yield* parseGuestsCsv(GUESTS_CSV, ev);
      const plan = yield* diffAgainstDb(ev, fam as ParsedFamily[], BOOTSTRAP_WEDDING_ID);
      yield* applyImport("import-seed", plan, BOOTSTRAP_WEDDING_ID);
    }).pipe(Effect.provide(layer)),
  );

  // Hand-add a manual household (the editor path — stamped source='manual') …
  const now = new Date();
  const manualFamilyId = crypto.randomUUID();
  await Promise.resolve(
    db
      .insert(families)
      .values({
        id: manualFamilyId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "MANUAL-FAM-0001",
        familyName: "Manualhousehold",
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  );
  await Promise.resolve(
    db
      .insert(guests)
      .values({
        id: crypto.randomUUID(),
        familyId: manualFamilyId,
        firstName: "Casey",
        lastName: "Manualhousehold",
        sortOrder: 0,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  );

  // … and a manual guest inside the IMPORTED household.
  const [importFam] = await Promise.resolve(
    db
      .select()
      .from(families)
      .where(
        and(eq(families.weddingId, BOOTSTRAP_WEDDING_ID), eq(families.familyName, "Importfamily")),
      )
      .all(),
  );
  await Promise.resolve(
    db
      .insert(guests)
      .values({
        id: crypto.randomUUID(),
        familyId: importFam!.id,
        firstName: "Dana",
        lastName: "Importfamily",
        sortOrder: 9,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  );

  return db;
}

/** Re-parse the SAME import sheet (which lacks the manual rows). */
async function reimportSameSheet(db: Db): Promise<{ ev: ParsedEvent[]; fam: ParsedFamily[] }> {
  const layer = Layer.succeed(DbService, db);
  return Effect.runPromise(
    Effect.gen(function* () {
      const ev = yield* parseEventsCsv(EVENTS_CSV);
      const fam = yield* parseGuestsCsv(GUESTS_CSV, ev);
      return { ev, fam: fam as ParsedFamily[] };
    }).pipe(Effect.provide(layer)),
  );
}

describe("provenance default — a CSV re-import leaves manual rows intact", () => {
  it("does NOT remove a manually-added household absent from the sheet", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await reimportSameSheet(db);

    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // The manual household is not in the sheet, but provenance default preserves
    // it: no family removal, no removal of its guest.
    expect(plan.familyRemoves).toHaveLength(0);
    const removedFirstNames = plan.guestRemoves.map((g) => g.firstName);
    expect(removedFirstNames).not.toContain("Casey");
  });

  it("does NOT remove a manually-added guest inside an imported household", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await reimportSameSheet(db);

    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // Dana (manual, inside the imported household) is absent from the sheet but
    // must survive — the imported siblings Ada/Bo match and stay.
    expect(plan.guestRemoves.map((g) => g.firstName)).not.toContain("Dana");
  });
});

describe("removeManual toggle — widens the diff to manage everything", () => {
  it("removes the manual household + manual guest when removeManual=true", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await reimportSameSheet(db);

    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID, { removeManual: true }).pipe(
        Effect.provide(layer),
      ),
    );

    // With the toggle set, the sheet is the whole truth: the manual household is
    // removed and the manual guest inside the imported household is removed.
    expect(plan.familyRemoves.map((f) => f.familyName)).toContain("Manualhousehold");
    expect(plan.guestRemoves.map((g) => g.firstName)).toEqual(
      expect.arrayContaining(["Casey", "Dana"]),
    );
  });
});

describe("import creates default to source='import'", () => {
  it("stamps a newly imported family + guest as import provenance", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const layer = Layer.succeed(DbService, db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ev = yield* parseEventsCsv(EVENTS_CSV);
        const fam = yield* parseGuestsCsv(GUESTS_CSV, ev);
        const plan = yield* diffAgainstDb(ev, fam as ParsedFamily[], BOOTSTRAP_WEDDING_ID);
        yield* applyImport("import-fresh", plan, BOOTSTRAP_WEDDING_ID);
      }).pipe(Effect.provide(layer)),
    );

    const famRows = await Promise.resolve(
      db.select().from(families).where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID)).all(),
    );
    expect(famRows.every((f) => f.source === "import")).toBe(true);
    const guestRows = await Promise.resolve(db.select().from(guests).all());
    expect(guestRows.length).toBeGreaterThan(0);
    expect(guestRows.every((g) => g.source === "import")).toBe(true);
  });
});
