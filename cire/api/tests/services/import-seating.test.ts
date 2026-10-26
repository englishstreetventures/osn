import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  guests,
  seatingAssignments,
  seatingPlans,
  seatingTables,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb, type TestDb } from "../../src/db/setup";
import type { ParsedFamily } from "../../src/schemas/import";
import { currentEventsAsParsed } from "../../src/services/changes";
import { applyImport, diffAgainstDb } from "../../src/services/import";
import { seatingLoss } from "../../src/services/seating";
import { parseEventsCsv, parseGuestsCsv } from "../../src/services/spreadsheet";

// What a spreadsheet import or an editor save does to the seating chart. Both
// go through `diffAgainstDb` then `applyImport`. A change that drops a guest,
// an invitation or an event takes seats (and, with an event, tables) away; the
// preview says how many before the organiser applies it, since no revert
// brings them back.

const RECEPTION = "9f7a2c14-1b3d-4e5f-8a01-000000000004";
const HINDU = "9f7a2c14-1b3d-4e5f-8a01-000000000003";

const EVENTS_CSV = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Catholic Ceremony,2026-10-31T10:00:00+11:00,2026-10-31T13:00:00+11:00,Australia/Sydney,Example Parish,123 Example St,Semiformal,Blush:oklch(86% 0.05 12),,",
  "Mehendi,2026-11-22T18:00:00+11:00,2026-11-22T23:00:00+11:00,Australia/Sydney,Sample Hall,124 Sample Avenue,Semicasual/Indian,Marigold:oklch(76% 0.15 75),,",
  "Hindu Ceremony,2026-11-25T09:00:00+11:00,2026-11-25T12:00:00+11:00,Australia/Sydney,Example Temple,125 Placeholder Hwy,Formal/Indian Traditional,Terracotta:oklch(58% 0.12 38),,",
  "Reception,2026-11-28T18:00:00+11:00,2026-11-28T23:00:00+11:00,Australia/Sydney,Sample Reception House,126 Example Road,Formal,Midnight:oklch(28% 0.06 268),,",
].join("\n");

const HEADER =
  "Family ID,Family Name,Guest First Name,Guest Last Name,Catholic Ceremony,Mehendi,Hindu Ceremony,Reception";
/** The seeded households, as the seed invites them. */
const SEEDED = [
  "1,Testfamily,Ada,Testfamily,yes,no,yes,yes",
  "2,Sampleton,Bo,Sampleton,no,no,yes,yes",
  "2,Sampleton,Cleo,Sampleton,no,no,yes,yes",
  "2,Sampleton,Dot,Sampleton,no,no,yes,no",
  "3,Exampleton,Nori,Exampleton,yes,no,yes,no",
  "4,Placeholder,Eli,Placeholder,no,no,yes,yes",
];

const guestId = (db: TestDb, firstName: string) =>
  db.select({ id: guests.id }).from(guests).where(eq(guests.firstName, firstName)).get()!.id;

/** A seating plan of the bootstrap wedding's `eventId`. */
function addPlan(db: TestDb, id: string, eventId: string, selected: boolean) {
  const now = new Date();
  db.insert(seatingPlans)
    .values({
      id,
      weddingId: BOOTSTRAP_WEDDING_ID,
      eventId,
      name: id,
      selected,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** A table in `planId`, seating each of `seated` by first name. */
function addTable(
  db: TestDb,
  id: string,
  planId: string,
  eventId: string,
  seated: readonly string[] = [],
) {
  const now = new Date();
  db.insert(seatingTables)
    .values({
      id,
      weddingId: BOOTSTRAP_WEDDING_ID,
      eventId,
      planId,
      name: id,
      capacity: 8,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  for (const name of seated) {
    db.insert(seatingAssignments)
      .values({ tableId: id, planId, eventId, guestId: guestId(db, name), createdAt: now })
      .run();
  }
}

/** The seeded wedding with the Reception's selected plan: one table seating
 *  Ada and Bo. */
function seatedDb(): TestDb {
  const db = createDb(":memory:");
  seedDb(db);
  addPlan(db, "spl_rec", RECEPTION, true);
  addTable(db, "stb_rec", "spl_rec", RECEPTION, ["Ada", "Bo"]);
  return db;
}

async function planFor(db: TestDb, rows: readonly string[]) {
  const ev = await Effect.runPromise(parseEventsCsv(EVENTS_CSV));
  const fam = (await Effect.runPromise(
    parseGuestsCsv([HEADER, ...rows].join("\n"), ev),
  )) as ParsedFamily[];
  return Effect.runPromise(
    diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(Layer.succeed(DbService, db))),
  );
}

const seatingWarnings = (warnings: readonly string[]) =>
  warnings.filter((w) => w.includes("seating chart"));

describe("import and editor saves — the seating chart", () => {
  it("warns how many seats a removed guest takes with them", async () => {
    const db = seatedDb();
    // Bo renamed Jim: an id-less first-name change is a remove + create.
    const plan = await planFor(
      db,
      SEEDED.map((row) => row.replace(",Bo,", ",Jim,")),
    );
    expect(seatingWarnings(plan.warnings)).toEqual([
      "This change clears 1 seat from the seating chart. Reverting it does not bring them back.",
    ]);
  });

  it("warns how many seats a withdrawn invitation clears", async () => {
    const db = seatedDb();
    // Ada no longer invited to the Reception.
    const plan = await planFor(
      db,
      SEEDED.map((row) =>
        row.startsWith("1,") ? "1,Testfamily,Ada,Testfamily,yes,no,yes,no" : row,
      ),
    );
    expect(seatingWarnings(plan.warnings)).toEqual([
      "This change clears 1 seat from the seating chart. Reverting it does not bring them back.",
    ]);
  });

  it("counts the seat a withdrawn invitation clears when it is all a change removes", async () => {
    const db = seatedDb();
    const loss = await Effect.runPromise(
      seatingLoss(BOOTSTRAP_WEDDING_ID, {
        guestIds: [],
        eventIds: [],
        links: [{ guestId: guestId(db, "Ada"), eventId: RECEPTION }],
      }).pipe(Effect.provide(Layer.succeed(DbService, db))),
    );
    expect(loss).toEqual({ seats: 1, tables: 0, plans: 1 });
  });

  it("counts every plan's seats and tables, and names how many plans lose them", async () => {
    const db = seatedDb();
    // A second Reception plan seating Ada, and a Hindu Ceremony plan seating
    // her too, which a change to the Reception does not touch.
    addPlan(db, "spl_rec_alt", RECEPTION, false);
    addTable(db, "stb_rec_alt", "spl_rec_alt", RECEPTION, ["Ada"]);
    addPlan(db, "spl_hindu", HINDU, true);
    addTable(db, "stb_hindu", "spl_hindu", HINDU, ["Ada"]);
    const invitation = await planFor(
      db,
      SEEDED.map((row) =>
        row.startsWith("1,") ? "1,Testfamily,Ada,Testfamily,yes,no,yes,no" : row,
      ),
    );
    expect(seatingWarnings(invitation.warnings)).toEqual([]);
    expect(invitation.warnings.filter((w) => w.includes("seating plans"))).toEqual([
      "This change clears 2 seats from 2 seating plans. Reverting it does not bring them back.",
    ]);
    const layer = Layer.succeed(DbService, db);
    const loss = await Effect.runPromise(
      seatingLoss(BOOTSTRAP_WEDDING_ID, { guestIds: [], eventIds: [RECEPTION], links: [] }).pipe(
        Effect.provide(layer),
      ),
    );
    expect(loss).toEqual({ seats: 3, tables: 2, plans: 2 });
  });

  it("says nothing about seating when no seat or table goes", async () => {
    const db = seatedDb();
    // Cleo (unseated) leaves; everyone seated stays.
    const plan = await planFor(
      db,
      SEEDED.filter((row) => !row.includes(",Cleo,")),
    );
    expect(plan.guestRemoves).toHaveLength(1);
    expect(seatingWarnings(plan.warnings)).toEqual([]);
  });

  it("names a single table in the singular", async () => {
    const db = seatedDb();
    const layer = Layer.succeed(DbService, db);
    const current = await Effect.runPromise(
      currentEventsAsParsed(BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    const plan = await Effect.runPromise(
      diffAgainstDb(
        current.filter((e) => e.id !== RECEPTION),
        [],
        BOOTSTRAP_WEDDING_ID,
        { scope: "events" },
      ).pipe(Effect.provide(layer)),
    );
    expect(seatingWarnings(plan.warnings)).toEqual([
      "This change clears 2 seats and removes 1 table from the seating chart. Reverting it does not bring them back.",
    ]);
  });

  it("counts an event's tables as well as its seats, and deletes them and its plans itself on apply", async () => {
    const db = seatedDb();
    // An empty second table at the Reception: an event removal takes it too.
    addTable(db, "stb_empty", "spl_rec", RECEPTION);
    // A plan, a table and a seat at an event the change keeps.
    addPlan(db, "spl_hindu", HINDU, true);
    addTable(db, "stb_hindu", "spl_hindu", HINDU, ["Bo"]);
    const layer = Layer.succeed(DbService, db);
    const current = await Effect.runPromise(
      currentEventsAsParsed(BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    const plan = await Effect.runPromise(
      diffAgainstDb(
        current.filter((e) => e.id !== RECEPTION),
        [],
        BOOTSTRAP_WEDDING_ID,
        { scope: "events" },
      ).pipe(Effect.provide(layer)),
    );
    expect(plan.eventRemoves.map((e) => e.id)).toEqual([RECEPTION]);
    expect(seatingWarnings(plan.warnings)).toEqual([
      "This change clears 2 seats and removes 2 tables from the seating chart. Reverting it does not bring them back.",
    ]);

    // The write set deletes the seats, tables and plans itself, the way it
    // already deletes an event's RSVPs and invitations: with foreign keys off,
    // nothing cascades, and nothing is left behind.
    db.$client.exec("PRAGMA foreign_keys = OFF;");
    await Effect.runPromise(
      applyImport("imp-seating-event-remove", plan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provide(layer),
      ),
    );
    // Only the removed event's: the kept event's table and seat are untouched.
    expect(
      db.select({ tableId: seatingAssignments.tableId }).from(seatingAssignments).all(),
    ).toEqual([{ tableId: "stb_hindu" }]);
    expect(db.select({ id: seatingTables.id }).from(seatingTables).all()).toEqual([
      { id: "stb_hindu" },
    ]);
    expect(db.select({ id: seatingPlans.id }).from(seatingPlans).all()).toEqual([
      { id: "spl_hindu" },
    ]);
  });
});
