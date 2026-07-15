import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, guests } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedBootstrapWedding } from "../db/setup";
import { DesiredState } from "../schemas/import";
import type { ParsedEvent, ParsedFamily } from "../schemas/import";
import { applyImport, diffAgainstDb } from "./import";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";
import { stateExportService } from "./state-export";

// A small fixture wedding built through the real pipeline so ids are the DB's
// own — the way a full-fidelity export/re-import produces them.
const EVENTS_CSV = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-11-22T18:00:00+11:00,2026-11-22T23:00:00+11:00,Australia/Sydney,,,,,,",
  "Reception,2026-11-28T18:00:00+11:00,2026-11-28T23:00:00+11:00,Australia/Sydney,,,,,,",
].join("\n");

const GUESTS_CSV = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
  "1,Testfamily,Ada,Testfamily,yes,yes",
  "1,Testfamily,Bo,Testfamily,no,yes",
  "2,Sampleton,Cleo,Sampleton,yes,no",
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
  return db;
}

/** Re-parse the wedding's own full-fidelity export → id-carrying DesiredState. */
async function fullFidelityRoundTrip(db: Db): Promise<{ ev: ParsedEvent[]; fam: ParsedFamily[] }> {
  const layer = Layer.succeed(DbService, db);
  return Effect.runPromise(
    Effect.gen(function* () {
      const eventsCsv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, "full");
      const guestsCsv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, "full");
      const ev = yield* parseEventsCsv(eventsCsv);
      const fam = yield* parseGuestsCsv(guestsCsv, ev);
      return { ev, fam: fam as ParsedFamily[] };
    }).pipe(Effect.provide(layer)),
  );
}

describe("ID-aware diff — rename by id ⇒ update, not remove+create", () => {
  it("renames an EVENT by id (keeps the row + all its invitations)", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await fullFidelityRoundTrip(db);

    // Rename Mehndi → "Mehndi Night" while keeping its id. A real full-fidelity
    // edit renames the event AND the guests-sheet attendance references in
    // lockstep (attendance is keyed by event NAME in the sheet), so rename both.
    const mehndi = ev.find((e) => e.name === "Mehndi")!;
    expect(mehndi.id).toBeDefined();
    const renamedEvents = ev.map((e) => (e.id === mehndi.id ? { ...e, name: "Mehndi Night" } : e));
    const renamedFams = fam.map((f) => ({
      ...f,
      guests: f.guests.map((g) => ({
        ...g,
        eventNames: g.eventNames.map((n) => (n === "Mehndi" ? "Mehndi Night" : n)),
      })),
    }));

    const plan = await Effect.runPromise(
      diffAgainstDb(renamedEvents, renamedFams, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // The rename is an UPDATE of the same id — never a remove+create. THIS is
    // the rename-safety guarantee: without id matching the renamed event would
    // be a fresh id (remove+create), rotating away every invitation.
    expect(plan.eventRemoves).toHaveLength(0);
    expect(plan.eventCreates).toHaveLength(0);
    const upd = plan.eventUpdates.find((u) => u.id === mehndi.id)!;
    expect(upd.event.name).toBe("Mehndi Night");
    // No invitations churn — the id kept every guest_event link on the SAME
    // event row, so the attendance set is unchanged.
    expect(plan.eventLinkCreates).toHaveLength(0);
    expect(plan.eventLinkRemoves).toHaveLength(0);
  });

  it("renames a HOUSEHOLD by id (preserves the family row + claim code)", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await fullFidelityRoundTrip(db);

    const testfam = fam.find((f) => f.familyName === "Testfamily")!;
    expect(testfam.id).toBeDefined();
    expect(testfam.publicId).toBeDefined();
    const renamed = fam.map((f) =>
      f.id === testfam.id ? { ...f, familyName: "Testfamily-Jones" } : f,
    );

    const plan = await Effect.runPromise(
      diffAgainstDb(ev, renamed, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    // The household is NOT removed+recreated — so its publicId (claim code) and
    // its guests survive untouched.
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.familyCreates).toHaveLength(0);
    expect(plan.guestRemoves).toHaveLength(0);
    expect(plan.guestCreates).toHaveLength(0);
  });

  it("renames a GUEST first name by id ⇒ update (not remove+create)", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await fullFidelityRoundTrip(db);

    // Fix "Ada" → "Adaeze" keeping the guest id.
    const renamed = fam.map((f) => ({
      ...f,
      guests: f.guests.map((g) => (g.firstName === "Ada" ? { ...g, firstName: "Adaeze" } : g)),
    }));

    const plan = await Effect.runPromise(
      diffAgainstDb(ev, renamed, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    expect(plan.guestCreates).toHaveLength(0);
    expect(plan.guestRemoves).toHaveLength(0);
    const upd = plan.guestUpdates.find((u) => u.firstName === "Adaeze")!;
    expect(upd).toBeDefined();
    // Applying the update actually writes the new first name through.
    await Effect.runPromise(
      applyImport("rename", plan, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    const row = db.select().from(guests).where(eq(guests.id, upd.id)).all()[0]!;
    expect(row.firstName).toBe("Adaeze");
  });

  it("an unknown id falls back to name matching, then create", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await fullFidelityRoundTrip(db);

    // A brand-new event carrying a bogus id ⇒ no id match, no name match ⇒ create.
    const withBogus: ParsedEvent[] = [
      ...ev,
      {
        id: "evt_does_not_exist",
        name: "Sangeet",
        startAt: "2026-11-20T18:00:00+11:00",
        endAt: "",
        timezone: "Australia/Sydney",
        location: null,
        address: null,
        dressCodeDescription: null,
        dressCodePalette: [],
        pinterestUrl: null,
        mapsUrl: null,
        sortOrder: ev.length,
      },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb(withBogus, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    expect(plan.eventCreates.map((c) => c.event.name)).toContain("Sangeet");
    expect(plan.eventRemoves).toHaveLength(0);
  });

  it("full-fidelity round trip with NO edits is a fixpoint (id-matched, no churn)", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await fullFidelityRoundTrip(db);
    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    expect(plan.eventCreates).toHaveLength(0);
    expect(plan.eventRemoves).toHaveLength(0);
    expect(plan.familyCreates).toHaveLength(0);
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.guestCreates).toHaveLength(0);
    expect(plan.guestUpdates).toHaveLength(0);
    expect(plan.guestRemoves).toHaveLength(0);
    expect(plan.eventLinkCreates).toHaveLength(0);
    expect(plan.eventLinkRemoves).toHaveLength(0);
  });
});

describe("no-id path is byte-identical to name-matched today", () => {
  // Build the SAME logical desired state two ways — with ids (full fidelity) and
  // without (standard, name-only) — against the SAME DB, and assert the two
  // plans agree on every write op EXCEPT that the no-id rename is remove+create
  // where the id path is an update. Here we prove the no-id plan itself is the
  // classic name-matched shape.

  it("an id-less first-name change stays remove+create (unchanged behaviour)", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    // Standard (no-id) export — parse it, then change a first name WITHOUT any id.
    const { ev, fam } = await Effect.runPromise(
      Effect.gen(function* () {
        const eventsCsv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, "import");
        const guestsCsv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, "import");
        const e = yield* parseEventsCsv(eventsCsv);
        const f = yield* parseGuestsCsv(guestsCsv, e);
        return { ev: e, fam: f as ParsedFamily[] };
      }).pipe(Effect.provide(layer)),
    );
    // No ids present anywhere in the parsed structures.
    expect(ev.every((e) => e.id === undefined)).toBe(true);
    expect(fam.every((f) => f.id === undefined && f.guests.every((g) => g.id === undefined))).toBe(
      true,
    );

    const renamed = fam.map((f) => ({
      ...f,
      guests: f.guests.map((g) => (g.firstName === "Ada" ? { ...g, firstName: "Adaeze" } : g)),
    }));
    const plan = await Effect.runPromise(
      diffAgainstDb(ev, renamed, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    // Classic behaviour: the old first name is removed, the new one created.
    expect(plan.guestRemoves.some((r) => r.firstName === "Ada")).toBe(true);
    expect(plan.guestCreates.some((c) => c.firstName === "Adaeze")).toBe(true);
    // And no guestUpdate carries a firstName field on the no-id path.
    expect(plan.guestUpdates.every((u) => u.firstName === undefined)).toBe(true);
  });

  it("standard export re-import is a fixpoint (name-matched, no id fields emitted)", async () => {
    const db = await seededWedding();
    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await Effect.runPromise(
      Effect.gen(function* () {
        const eventsCsv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, "import");
        const guestsCsv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, "import");
        const e = yield* parseEventsCsv(eventsCsv);
        const f = yield* parseGuestsCsv(guestsCsv, e);
        return { ev: e, fam: f as ParsedFamily[] };
      }).pipe(Effect.provide(layer)),
    );
    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    expect(plan.eventCreates).toHaveLength(0);
    expect(plan.eventRemoves).toHaveLength(0);
    expect(plan.familyCreates).toHaveLength(0);
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.guestCreates).toHaveLength(0);
    expect(plan.guestUpdates).toHaveLength(0);
    expect(plan.guestRemoves).toHaveLength(0);
    expect(plan.eventLinkCreates).toHaveLength(0);
    expect(plan.eventLinkRemoves).toHaveLength(0);
  });
});

describe("DesiredState schema — canonical desired state both front doors reconcile to", () => {
  it("decodes the parser's full-fidelity output (ids + per-household code present)", async () => {
    const db = await seededWedding();
    const { ev, fam } = await fullFidelityRoundTrip(db);
    // The parser's { events, families } is a valid DesiredState — decode round
    // trips it (Effect Schema, services layer).
    const decoded = Schema.decodeUnknownSync(DesiredState)({ events: ev, families: fam });
    expect(decoded.events.length).toBeGreaterThan(0);
    expect(decoded.families.length).toBeGreaterThan(0);
    // Every household carries a code (households-always-coded model) and an id.
    for (const f of decoded.families) {
      expect(f.id).toBeDefined();
      expect(f.publicId).toBeDefined();
    }
    for (const e of decoded.events) expect(e.id).toBeDefined();
  });

  it("decodes an id-less DesiredState (editor-created / standard import)", () => {
    const decoded = Schema.decodeUnknownSync(DesiredState)({
      events: [
        {
          name: "Mehndi",
          startAt: "2026-11-22T18:00:00+11:00",
          endAt: "",
          timezone: "Australia/Sydney",
          location: null,
          address: null,
          dressCodeDescription: null,
          dressCodePalette: [],
          pinterestUrl: null,
          mapsUrl: null,
          sortOrder: 0,
        },
      ],
      families: [
        {
          familyName: "Testfamily",
          guests: [{ firstName: "Ada", lastName: "Testfamily", nickname: null, eventNames: [] }],
        },
      ],
    });
    expect(decoded.events[0]!.id).toBeUndefined();
    expect(decoded.families[0]!.id).toBeUndefined();
    expect(decoded.families[0]!.publicId).toBeUndefined();
  });
});
