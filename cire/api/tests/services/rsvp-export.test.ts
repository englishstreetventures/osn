import { describe, it, expect } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guestEvents,
  guests,
  rsvps,
  weddings,
} from "@cire/db";
import { events as eventsSeed } from "@cire/db/seed";
import { serialisePresets, type DietaryPreset } from "@cire/dietary";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { Db } from "../../src/db";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { rsvpExportService, toCsv, sanitiseCsvCell } from "../../src/services/rsvp-export";
import type { RsvpView } from "../../src/services/rsvp-export";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { allowPlusOne, guestNamed, seedPlusOne } from "../test-helpers/plus-one";

const withDb = effWith(TestDbLayer);

/** The export's own name for an event — the CSV header is built from it. */
function eventName(data: { events: { id: string; name: string }[] }, eventId: string): string {
  return data.events.find((e) => e.id === eventId)!.name;
}

/**
 * Insert an RSVP row for a guest+event.
 *
 * `presets` goes in through `serialisePresets`, the same function the routes
 * write the column with — a hand-written string here would prove the export
 * against a column shape nothing produces.
 */
function rsvp(
  db: Db,
  guestId: string,
  eventId: string,
  status: "attending" | "declined" | "maybe",
  dietary = "",
  consentSource: "guest" | "organiser_attested" = "guest",
  presets: readonly DietaryPreset[] = [],
) {
  db.insert(rsvps)
    .values({
      id: crypto.randomUUID(),
      guestId,
      eventId,
      status,
      dietary,
      dietaryPresets: serialisePresets(presets),
      consentSource,
      createdAt: new Date(),
    })
    .run();
}

/** A guest by first name in the bootstrap wedding (seed mints random ids). */
function guestByName(db: Db, firstName: string): Effect.Effect<{ id: string }> {
  return Effect.gen(function* () {
    const rows = yield* Effect.promise(() =>
      Promise.resolve(
        db.select({ id: guests.id }).from(guests).where(eq(guests.firstName, firstName)).all(),
      ),
    );
    const row = rows[0];
    if (!row) throw new Error(`no guest named ${firstName}`);
    return row;
  });
}

/** An event id by slug. */
function eventBySlug(db: Db, slug: string): Effect.Effect<{ id: string }> {
  return Effect.gen(function* () {
    const rows = yield* Effect.promise(() =>
      Promise.resolve(db.select({ id: events.id }).from(events).where(eq(events.slug, slug)).all()),
    );
    const row = rows[0];
    if (!row) throw new Error(`no event ${slug}`);
    return row;
  });
}

describe("rsvpExportService.build", () => {
  it(
    "includes one row per guest, even guests who have not RSVP'd",
    withDb(
      Effect.gen(function* () {
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        // The seed has 6 guests and never writes an RSVP — all 6 still appear.
        expect(data.rows).toHaveLength(6);
      }),
    ),
  );

  it(
    "excludes host-kind families",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        // Plant a synthetic host family + guest.
        db.insert(families)
          .values({
            id: "fam_host",
            weddingId: BOOTSTRAP_WEDDING_ID,
            publicId: "HOST-AAAA",
            familyName: "Wedding Host",
            kind: "host",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(guests)
          .values({
            id: "gst_host",
            familyId: "fam_host",
            firstName: "Hosty",
            lastName: "McHost",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();

        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        // Still 6 — the host guest must not leak in.
        expect(data.rows).toHaveLength(6);
        expect(data.rows.find((r) => r.firstName === "Hosty")).toBeUndefined();
        expect(data.rows.find((r) => r.familyCode.startsWith("HOST-"))).toBeUndefined();
      }),
    ),
  );

  it(
    "orders rows alphabetically by family code",
    withDb(
      Effect.gen(function* () {
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const codes = data.rows.map((r) => r.familyCode);
        expect(codes).toEqual([...codes].toSorted());
      }),
    ),
  );

  it(
    "orders event columns by start time",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        // Resolve each export event's startAt and assert non-decreasing order.
        const eventRows = yield* Effect.promise(() =>
          Promise.resolve(db.select({ id: events.id, startAt: events.startAt }).from(events).all()),
        );
        const startById = new Map(eventRows.map((e) => [e.id, e.startAt]));
        const starts = data.events.map((e) => Date.parse(startById.get(e.id) ?? ""));
        for (let i = 1; i < starts.length; i += 1) {
          expect(starts[i]! >= starts[i - 1]!).toBe(true);
        }
      }),
    ),
  );

  it(
    "distinguishes attending / not-attending / maybe / no-response / not-invited cells",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        // Ada (TESTONE family) is invited to catholic, hindu, reception — NOT
        // kitchen-tea / mehendi.
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        const hindu = yield* eventBySlug(db, "hindu");
        const reception = yield* eventBySlug(db, "reception");

        // attending catholic (with dietary), declined hindu, maybe reception,
        // no rsvp for the others she's invited to (none here — she's invited to
        // exactly those three, so reception=maybe, none left as no_response).
        rsvp(db, ada.id, catholic.id, "attending", "Nut allergy");
        rsvp(db, ada.id, hindu.id, "declined");
        // Leave reception with no RSVP → "No response" (invited, not answered).

        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada")!;
        expect(adaRow).toBeDefined();

        const cellFor = (eventId: string) =>
          adaRow.cells[data.events.findIndex((e) => e.id === eventId)];

        expect(cellFor(catholic.id)).toBe("attending");
        expect(cellFor(hindu.id)).toBe("not_attending");
        expect(cellFor(reception.id)).toBe("no_response");
        // She is NOT invited to kitchen-tea → blank cell.
        const kitchenTea = yield* eventBySlug(db, "kitchen-tea");
        expect(cellFor(kitchenTea.id)).toBe("not_invited");
      }),
    ),
  );

  it(
    "maps the schema 'maybe' status to a distinct maybe cell",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const reception = yield* eventBySlug(db, "reception");
        rsvp(db, ada.id, reception.id, "maybe");
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada")!;
        const cell = adaRow.cells[data.events.findIndex((e) => e.id === reception.id)];
        expect(cell).toBe("maybe");
      }),
    ),
  );

  it(
    "surfaces the guest's dietary requirement against the event it was given for",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "attending", "Vegetarian, no nuts");
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada")!;
        const catholicIdx = data.events.findIndex((e) => e.id === catholic.id);
        expect(adaRow.dietary[catholicIdx]).toBe("Vegetarian, no nuts");
        // …and nowhere else: the other events keep a blank cell.
        expect(adaRow.dietary.filter((d) => d.length > 0)).toEqual(["Vegetarian, no nuts"]);
        // The array is index-aligned with the status cells and the event list.
        expect(adaRow.dietary.length).toBe(data.events.length);
        expect(adaRow.dietary.length).toBe(adaRow.cells.length);
        // A guest with no dietary note has blank cells throughout.
        const other = data.rows.find(
          (r) => r.firstName !== "Ada" && r.dietary.every((d) => d === ""),
        );
        expect(other).toBeDefined();
      }),
    ),
  );

  it(
    "keeps a DIFFERENT dietary note per event instead of picking one (field report)",
    withDb(
      Effect.gen(function* () {
        // The bug as reported from a live wedding: a guest marked "fish only"
        // for one event and something else for another, and the download showed
        // a single value. `rsvps.dietary` is per (guest, event), so any single
        // column has to drop one of two answers that are BOTH true — and the
        // caterer for each event needs their own.
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        const reception = yield* eventBySlug(db, "reception");
        rsvp(db, ada.id, catholic.id, "attending", "Fish only");
        rsvp(db, ada.id, reception.id, "attending", "Vegetarian");

        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada")!;
        const at = (eventId: string) =>
          adaRow.dietary[data.events.findIndex((e) => e.id === eventId)];
        expect(at(catholic.id)).toBe("Fish only");
        expect(at(reception.id)).toBe("Vegetarian");

        // And both survive into the CSV, each under its own event's column.
        const csv = toCsv(data);
        const [header, ...lines] = csv.split("\r\n");
        const cols = header!.split(",");
        const row = lines.find((l) => l.includes("Ada"))!.split(",");
        expect(row[cols.indexOf(`${eventName(data, catholic.id)} Dietary`)]).toBe("Fish only");
        expect(row[cols.indexOf(`${eventName(data, reception.id)} Dietary`)]).toBe("Vegetarian");
      }),
    ),
  );

  it(
    "blanks the dietary cell for an event the guest declined, keeping the stored answer",
    withDb(
      Effect.gen(function* () {
        // An organiser's status-only decline keeps the stored answer, but no
        // caterer is cooking for a guest who is not coming.
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "declined", "Fish only");

        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada")!;
        const idx = data.events.findIndex((e) => e.id === catholic.id);
        expect(adaRow.cells[idx]).toBe("not_attending");
        expect(adaRow.dietary[idx]).toBe("");
      }),
    ),
  );

  it(
    "blanks the dietary cell for an event the guest is no longer invited to",
    withDb(
      Effect.gen(function* () {
        // A reply that outlived its invitation. The status column already shows
        // blank ("not_invited"), so the dietary column must too — a requirement
        // sitting beside an empty status reads as a bug, and no caterer is
        // cooking for a guest who isn't on the list.
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "attending", "Fish only");
        db.delete(guestEvents)
          .where(and(eq(guestEvents.guestId, ada.id), eq(guestEvents.eventId, catholic.id)))
          .run();

        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada")!;
        const idx = data.events.findIndex((e) => e.id === catholic.id);
        expect(adaRow.cells[idx]).toBe("not_invited");
        expect(adaRow.dietary[idx]).toBe("");
      }),
    ),
  );

  it(
    "leaves a guest with no invites entirely blank (all not-invited)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        // A family + guest invited to nothing.
        db.insert(families)
          .values({
            id: "fam_lonely",
            weddingId: BOOTSTRAP_WEDDING_ID,
            publicId: "AAAA-LONELY-0000",
            familyName: "Lonely",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(guests)
          .values({
            id: "gst_lonely",
            familyId: "fam_lonely",
            firstName: "Lonely",
            lastName: "Guest",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();

        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const lonely = data.rows.find((r) => r.firstName === "Lonely")!;
        expect(lonely).toBeDefined();
        expect(lonely.cells.every((c) => c === "not_invited")).toBe(true);
      }),
    ),
  );

  it(
    "is scoped to the wedding — another wedding's guests do not leak in",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        // A second, real wedding with its own family/guest.
        db.insert(weddings)
          .values({
            id: "wed_other_scope",
            slug: "other-scope",
            displayName: "Other Scope",
            ownerOsnProfileId: "usr_other",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(families)
          .values({
            id: "fam_x",
            weddingId: "wed_other_scope",
            publicId: "OTHER-XXXX",
            familyName: "Outsider",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(guests)
          .values({
            id: "gst_x",
            familyId: "fam_x",
            firstName: "Outsider",
            lastName: "Person",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();

        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        expect(data.rows).toHaveLength(6);
        expect(data.rows.find((r) => r.firstName === "Outsider")).toBeUndefined();
      }),
    ),
  );
});

describe("rsvp-export CSV serialisation", () => {
  it(
    "emits the fixed columns + a status/dietary PAIR per event + Recorded By + Plus-one Of",
    withDb(
      Effect.gen(function* () {
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const csv = toCsv(data);
        const header = csv.split("\r\n")[0]!.split(",");
        expect(header.slice(0, 4)).toEqual([
          "Family Code",
          "Family Name",
          "Guest First Name",
          "Guest Last Name",
        ]);
        // Two trailing columns: writer provenance (0037), then the plus-one's
        // inviter, appended last so a saved spreadsheet's column letters hold.
        // The aggregate "Dietary Requirements" column is gone — it could only
        // show one of a guest's per-event answers.
        expect(header.slice(-2)).toEqual(["Recorded By", "Plus-one Of"]);
        expect(header).not.toContain("Dietary Requirements");
        // Each event contributes a PAIR, interleaved so the caterer for one
        // event reads its status and its dietary note side by side.
        expect(header.slice(4, -2)).toEqual(
          data.events.flatMap((e) => [e.name, `${e.name} Dietary`]),
        );
        expect(header.length).toBe(4 + data.events.length * 2 + 2);
        // Every data row is the same width as the header — an off-by-one in the
        // interleave would shift every column after the first event.
        //
        // Splitting on "," is only a valid way to count columns while no cell
        // needs RFC 4180 quoting, so assert that precondition rather than
        // relying on it: a seed family name of "Smith, Jr." would otherwise make
        // this fail for a reason that has nothing to do with the interleave.
        expect(csv).not.toContain('"');
        for (const line of csv.split("\r\n").slice(1)) {
          expect(line.split(",").length).toBe(header.length);
        }
      }),
    ),
  );

  it(
    "labels an organiser-attested reply 'Organiser' in the Recorded By column (0037)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        // An organiser-recorded RSVP; a self-submitted one stays "Guest".
        rsvp(db, ada.id, catholic.id, "attending", "", "organiser_attested");
        const bo = yield* guestByName(db, "Bo");
        const reception = yield* eventBySlug(db, "reception");
        rsvp(db, bo.id, reception.id, "attending", "", "guest");
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada");
        const boRow = data.rows.find((r) => r.firstName === "Bo");
        expect(adaRow?.recordedBy).toBe("organiser");
        expect(boRow?.recordedBy).toBe("guest");
        // Guests with no RSVP at all get a blank provenance cell.
        const noReply = data.rows.find((r) => r.recordedBy === "");
        expect(noReply).toBeDefined();
        const csv = toCsv(data);
        expect(csv).toContain("Organiser");
      }),
    ),
  );

  it(
    "renders cell labels in CSV (Attending / Not attending / No response / blank)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        const hindu = yield* eventBySlug(db, "hindu");
        rsvp(db, ada.id, catholic.id, "attending");
        rsvp(db, ada.id, hindu.id, "declined");
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const csv = toCsv(data);
        expect(csv).toContain("Attending");
        expect(csv).toContain("Not attending");
        expect(csv).toContain("No response");
      }),
    ),
  );

  it(
    "writes presets into the caterer's dietary cell, with the free text after them",
    withDb(
      Effect.gen(function* () {
        // The CSV is what a caterer cooks from, and nothing else in this suite
        // exports a non-empty `dietary_presets` — so the `formatDietaryCell`
        // call on the build path is unasserted, and `parsePresets` is total, so
        // a broken read gives `[]` and an empty-looking cell rather than an
        // error. Three shapes, because the separator is where this breaks:
        // presets alone must gain no trailing "; ", prose alone no leading one.
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        const hindu = yield* eventBySlug(db, "hindu");
        const reception = yield* eventBySlug(db, "reception");
        rsvp(db, ada.id, catholic.id, "attending", "", "guest", ["vegetarian", "nuts"]);
        rsvp(db, ada.id, hindu.id, "attending", "No onion", "guest", ["other"]);
        rsvp(db, ada.id, reception.id, "attending", "Coeliac");

        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada")!;
        const dietaryFor = (eventId: string) =>
          adaRow.dietary[data.events.findIndex((e) => e.id === eventId)];

        expect(dietaryFor(catholic.id)).toBe("Vegetarian; Nuts");
        expect(dietaryFor(hindu.id)).toBe("Other; No onion");
        expect(dietaryFor(reception.id)).toBe("Coeliac");

        // And the labels reach the file itself, not just the row model.
        const csv = toCsv(data);
        expect(csv).toContain("Vegetarian; Nuts");
      }),
    ),
  );

  it("sanitises formula-injection cells with a leading quote", () => {
    expect(sanitiseCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(sanitiseCsvCell("+1")).toBe("'+1");
    expect(sanitiseCsvCell("-1")).toBe("'-1");
    expect(sanitiseCsvCell("@cmd")).toBe("'@cmd");
    // Leading whitespace is a known bypass — trim first.
    expect(sanitiseCsvCell("  =EVIL()")).toBe("'  =EVIL()");
    // Ordinary values are untouched.
    expect(sanitiseCsvCell("Ada")).toBe("Ada");
    expect(sanitiseCsvCell("")).toBe("");
  });

  it(
    "quotes fields containing commas (RFC 4180) after sanitisation",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "attending", "Vegetarian, no nuts");
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const csv = toCsv(data);
        expect(csv).toContain('"Vegetarian, no nuts"');
      }),
    ),
  );
});

describe("rsvpExportService.buildView (in-dashboard read-only view)", () => {
  it(
    "lists every wedding event, even ones with no responses (empty + zeroed)",
    withDb(
      Effect.gen(function* () {
        const view = yield* rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID);
        // The seed has the full event set; with no RSVPs every event has an empty
        // guest list + zero counts but still appears.
        expect(view.events.length).toBeGreaterThan(0);
        for (const e of view.events) {
          expect(e.guests).toHaveLength(0);
          expect(e.attending).toBe(0);
          expect(e.responded).toBe(0);
        }
      }),
    ),
  );

  it(
    "groups responded guests under their event with correct counts + dietary",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const bo = yield* guestByName(db, "Bo");
        const catholic = yield* eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "attending", "Gluten free");
        rsvp(db, bo.id, catholic.id, "declined");

        const view = yield* rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID);
        const event = view.events.find((e) => e.id === catholic.id)!;
        expect(event.attending).toBe(1);
        expect(event.declined).toBe(1);
        expect(event.maybe).toBe(0);
        expect(event.responded).toBe(2);
        expect(event.guests).toHaveLength(2);

        const adaRow = event.guests.find((g) => g.guestId === ada.id)!;
        expect(adaRow.status).toBe("attending");
        expect(adaRow.dietary).toBe("Gluten free");
        const boRow = event.guests.find((g) => g.guestId === bo.id)!;
        expect(boRow.status).toBe("declined");
      }),
    ),
  );

  it(
    "parses the presets column back into the dashboard view's guest rows",
    withDb(
      Effect.gen(function* () {
        // The second of the two places that format a dietary answer. The CSV
        // path and this one read the same column through different code, so a
        // revert of either is only caught if both are asserted.
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        // Stored allergy-first; `serialisePresets` canonicalises, so the view
        // gets diet-first whatever order it was picked in.
        rsvp(db, ada.id, catholic.id, "attending", "No onion", "guest", ["nuts", "vegetarian"]);

        const view = yield* rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID);
        const event = view.events.find((e) => e.id === catholic.id)!;
        const adaRow = event.guests.find((g) => g.guestId === ada.id)!;
        expect(adaRow.dietaryPresets).toEqual(["vegetarian", "nuts"]);
        // The free text stays its own field — the view does not pre-join them.
        expect(adaRow.dietary).toBe("No onion");
      }),
    ),
  );

  it(
    "carries who sent each reply, and whether through a linked account",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const bo = yield* guestByName(db, "Bo");
        const catholic = yield* eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "attending");
        rsvp(db, bo.id, catholic.id, "attending");
        db.update(rsvps)
          .set({ submittedByGuestId: bo.id, submittedViaLink: true })
          .where(and(eq(rsvps.guestId, ada.id), eq(rsvps.eventId, catholic.id)))
          .run();

        const view = yield* rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID);
        const event = view.events.find((e) => e.id === catholic.id)!;
        expect(event.guests.find((g) => g.guestId === ada.id)!.submittedBy).toEqual({
          guestId: bo.id,
          firstName: "Bo",
          viaLink: true,
        });
        // An organiser-style write carries no submitter.
        expect(event.guests.find((g) => g.guestId === bo.id)!.submittedBy).toBeNull();
      }),
    ),
  );

  it(
    "computes noResponse = invited − responded (never negative)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "attending");
        const view = yield* rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID);
        const event = view.events.find((e) => e.id === catholic.id)!;
        expect(event.invited).toBeGreaterThanOrEqual(event.responded);
        expect(event.noResponse).toBe(event.invited - event.responded);
        expect(event.noResponse).toBeGreaterThanOrEqual(0);
      }),
    ),
  );

  it(
    "lists invited-but-unresponded guests, dropping them once they reply (0037)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");

        // Before any reply: Ada (invited to catholic) is in `unresponded`.
        let view = yield* rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID);
        let event = view.events.find((e) => e.id === catholic.id)!;
        expect(event.unresponded.some((g) => g.guestId === ada.id)).toBe(true);
        expect(event.guests.some((g) => g.guestId === ada.id)).toBe(false);

        // After she replies she moves out of `unresponded` into `guests`.
        rsvp(db, ada.id, catholic.id, "attending");
        view = yield* rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID);
        event = view.events.find((e) => e.id === catholic.id)!;
        expect(event.unresponded.some((g) => g.guestId === ada.id)).toBe(false);
        expect(event.guests.some((g) => g.guestId === ada.id)).toBe(true);
      }),
    ),
  );

  it(
    "surfaces consentSource so the dashboard can badge organiser-entered replies (0037)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* guestByName(db, "Ada");
        const catholic = yield* eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "attending", "", "organiser_attested");
        const view = yield* rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID);
        const event = view.events.find((e) => e.id === catholic.id)!;
        const row = event.guests.find((g) => g.guestId === ada.id)!;
        expect(row.consentSource).toBe("organiser_attested");
      }),
    ),
  );

  it(
    "excludes a host-preview family's RSVPs from the view",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        const catholic = yield* eventBySlug(db, "catholic");
        db.insert(families)
          .values({
            id: "fam_host_view",
            weddingId: BOOTSTRAP_WEDDING_ID,
            publicId: "HOST-VIEWAAAAAAAAAAAAAAAAAAAAAAAA",
            familyName: "Wedding Host",
            kind: "host",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(guests)
          .values({
            id: "gst_host_view",
            familyId: "fam_host_view",
            firstName: "Hosty",
            lastName: "Preview",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        rsvp(db, "gst_host_view", catholic.id, "attending");

        const view = yield* rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID);
        const event = view.events.find((e) => e.id === catholic.id)!;
        expect(event.guests.find((g) => g.guestId === "gst_host_view")).toBeUndefined();
        expect(event.attending).toBe(0);
      }),
    ),
  );
});

/**
 * A named plus-one is an ordinary guest row, invited to their inviter's events,
 * so the per-event tallies count them once named and once they reply —
 * permission alone creates no row and counts toward nothing.
 */
describe("rsvpExportService.buildView — plus-ones in the tallies", () => {
  const setUp = () => {
    const db = createDb(":memory:");
    seedDb(db);
    const run = <A, E>(eff: Effect.Effect<A, E, DbService>) =>
      Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));
    const hindu = (view: RsvpView) => view.events.find((e) => e.id === HINDU)!;
    return { db, run, hindu };
  };
  const HINDU = eventsSeed.hindu.id;

  /** The household's reply for `guestId` to the Hindu ceremony, as the invite
   *  stamps a plus-one's. */
  const replyAs = (db: Db, guestId: string, status: "attending" | "declined") =>
    db
      .insert(rsvps)
      .values({
        id: `r_${guestId}`,
        guestId,
        eventId: HINDU,
        status,
        consentSource: "inviter_attested",
        createdAt: new Date(),
      })
      .run();

  /** Reorder the household so `guestId` comes last. */
  const moveLast = (db: Db, guestId: string) =>
    db.update(guests).set({ sortOrder: 9 }).where(eq(guests.id, guestId)).run();

  it("adds nothing for a permission with no plus-one named", async () => {
    const { db, run, hindu } = setUp();
    const before = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    allowPlusOne(db, guestNamed(db, "Bo").id);
    const after = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    expect(after.invited).toBe(before.invited);
    expect(after.attending).toBe(before.attending);
  });

  it("counts a named plus-one as invited, and as attending once they reply", async () => {
    const { db, run, hindu } = setUp();
    const bo = guestNamed(db, "Bo");
    const before = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));

    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    const named = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    expect(named.invited).toBe(before.invited + 1);
    expect(named.unresponded.find((g) => g.guestId === samId)?.plusOneOf).toBe(bo.id);

    db.insert(rsvps)
      .values({
        id: "r_sam",
        guestId: samId,
        eventId: HINDU,
        status: "attending",
        consentSource: "inviter_attested",
        createdAt: new Date(),
      })
      .run();
    const replied = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    expect(replied.attending).toBe(before.attending + 1);
    expect(replied.guests.find((g) => g.guestId === samId)).toMatchObject({
      plusOneOf: bo.id,
      consentSource: "inviter_attested",
    });
    // Everyone else carries a null.
    expect(
      replied.guests.filter((g) => g.guestId !== samId).every((g) => g.plusOneOf === null),
    ).toBe(true);
  });

  it("names the inviter on a plus-one's entries, and on no one else's", async () => {
    const { db, run, hindu } = setUp();
    const samId = seedPlusOne(db, guestNamed(db, "Bo").id, { firstName: "Sam" });
    const silent = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    expect(silent.unresponded.find((g) => g.guestId === samId)?.plusOneOfName).toBe("Bo Sampleton");
    expect(
      silent.unresponded.filter((g) => g.guestId !== samId).every((g) => g.plusOneOfName === null),
    ).toBe(true);

    replyAs(db, samId, "attending");
    const replied = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    expect(replied.guests.find((g) => g.guestId === samId)?.plusOneOfName).toBe("Bo Sampleton");
  });

  it("names the inviter on a reply to an event neither is invited to any more", async () => {
    // A change that drops the household from an event removes the invitations
    // and keeps the replies, so the plus-one's reply is still listed under it
    // while the inviter, who never replied, is in neither list.
    const { db, run, hindu } = setUp();
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    replyAs(db, samId, "attending");
    db.delete(guestEvents)
      .where(and(eq(guestEvents.eventId, HINDU), inArray(guestEvents.guestId, [bo.id, samId])))
      .run();

    const event = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    expect(event.unresponded.find((g) => g.guestId === bo.id)).toBeUndefined();
    expect(event.guests.find((g) => g.guestId === samId)?.plusOneOfName).toBe("Bo Sampleton");
  });

  it("lists a plus-one straight after their inviter, not by the sort order copied at naming", async () => {
    const { db, run, hindu } = setUp();
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    // The household reordered after Sam was named: Bo moved last, and Sam kept
    // the number copied from Bo, now the lowest in the household.
    moveLast(db, bo.id);

    const event = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    const order = event.unresponded.map((g) => g.guestId);
    expect(order.indexOf(samId)).toBe(order.indexOf(bo.id) + 1);

    replyAs(db, bo.id, "attending");
    replyAs(db, samId, "attending");
    const replied = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    const repliedOrder = replied.guests.map((g) => g.guestId);
    expect(repliedOrder.indexOf(samId)).toBe(repliedOrder.indexOf(bo.id) + 1);
  });

  it("marks a plus-one's CSV row with their inviter, last column, straight after the inviter", async () => {
    const { db, run } = setUp();
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam", lastName: "Lee" });
    moveLast(db, bo.id);

    const data = await run(rsvpExportService.build(BOOTSTRAP_WEDDING_ID));
    const names = data.rows.map((r) => r.firstName);
    expect(names.indexOf("Sam")).toBe(names.indexOf("Bo") + 1);
    expect(data.rows.find((r) => r.firstName === "Sam")?.plusOneOfName).toBe("Bo Sampleton");
    expect(
      data.rows.filter((r) => r.firstName !== "Sam").every((r) => r.plusOneOfName === ""),
    ).toBe(true);

    const lines = toCsv(data).split("\r\n");
    expect(lines[0]!.split(",").at(-1)).toBe("Plus-one Of");
    expect(
      lines
        .find((l) => l.includes(",Sam,Lee,"))!
        .split(",")
        .at(-1),
    ).toBe("Bo Sampleton");
    expect(
      lines
        .find((l) => l.includes(",Bo,Sampleton,"))!
        .split(",")
        .at(-1),
    ).toBe("");
  });

  it("files a reply the household typed for its plus-one as 'Household' in the CSV", async () => {
    const { db, run } = setUp();
    const samId = seedPlusOne(db, guestNamed(db, "Bo").id, { firstName: "Sam" });
    replyAs(db, samId, "attending");
    const data = await run(rsvpExportService.build(BOOTSTRAP_WEDDING_ID));
    const sam = data.rows.find((r) => r.firstName === "Sam")!;
    expect(sam.recordedBy).toBe("household");
    const line = toCsv(data)
      .split("\r\n")
      .find((l) => l.includes(",Sam,"))!
      .split(",");
    // Recorded By sits before the appended Plus-one Of column.
    expect(line.at(-2)).toBe("Household");
  });

  it("files a plus-one as 'Organiser' once an organiser has recorded any of their replies", async () => {
    const { db, run } = setUp();
    const samId = seedPlusOne(db, guestNamed(db, "Bo").id, { firstName: "Sam" });
    replyAs(db, samId, "attending");
    db.insert(rsvps)
      .values({
        id: "r_sam_reception",
        guestId: samId,
        eventId: eventsSeed.reception.id,
        status: "declined",
        consentSource: "organiser_attested",
        createdAt: new Date(),
      })
      .run();
    const data = await run(rsvpExportService.build(BOOTSTRAP_WEDDING_ID));
    expect(data.rows.find((r) => r.firstName === "Sam")?.recordedBy).toBe("organiser");
  });

  it("keeps 'Organiser' when the household's reply is read after the organiser's", async () => {
    // The mirror of the case above: the organiser recorded the Hindu ceremony
    // and the household answered the reception, so the rows come back the
    // other way round.
    const { db, run } = setUp();
    const samId = seedPlusOne(db, guestNamed(db, "Bo").id, { firstName: "Sam" });
    db.insert(rsvps)
      .values([
        {
          id: "r_sam_hindu",
          guestId: samId,
          eventId: HINDU,
          status: "declined",
          consentSource: "organiser_attested",
          createdAt: new Date(),
        },
        {
          id: "r_sam_reception",
          guestId: samId,
          eventId: eventsSeed.reception.id,
          status: "attending",
          consentSource: "inviter_attested",
          createdAt: new Date(),
        },
      ])
      .run();
    const data = await run(rsvpExportService.build(BOOTSTRAP_WEDDING_ID));
    expect(data.rows.find((r) => r.firstName === "Sam")?.recordedBy).toBe("organiser");
    const line = toCsv(data)
      .split("\r\n")
      .find((l) => l.includes(",Sam,"))!
      .split(",");
    expect(line.at(-2)).toBe("Organiser");
  });

  it("names no inviter outside the plus-one's own household", async () => {
    // A plus-one always shares their inviter's household, and the join says so
    // itself rather than trusting every writer: a link pointing at a guest in
    // another wedding, or in another household, yields no name.
    const { db, run, hindu } = setUp();
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_other",
        slug: "other-wedding",
        displayName: "Other",
        ownerOsnProfileId: "usr_other",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(families)
      .values({
        id: "fam_other",
        weddingId: "wed_other",
        publicId: "OTHER-XXXX",
        familyName: "Outsider",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(guests)
      .values({
        id: "gst_outsider",
        familyId: "fam_other",
        firstName: "Outsider",
        lastName: "Person",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const samId = seedPlusOne(db, guestNamed(db, "Bo").id, { firstName: "Sam" });
    const kitId = seedPlusOne(db, guestNamed(db, "Cleo").id, { firstName: "Kit" });
    db.update(guests).set({ plusOneOfGuestId: "gst_outsider" }).where(eq(guests.id, samId)).run();
    db.update(guests)
      .set({ plusOneOfGuestId: guestNamed(db, "Ada").id })
      .where(eq(guests.id, kitId))
      .run();
    replyAs(db, samId, "attending");

    const event = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    const entries = [...event.guests, ...event.unresponded];
    expect(entries.find((g) => g.guestId === samId)?.plusOneOfName).toBeNull();
    expect(entries.find((g) => g.guestId === kitId)?.plusOneOfName).toBeNull();
    expect(JSON.stringify(event)).not.toContain("Outsider");
  });

  it("names an inviter with no last name without a trailing space", async () => {
    const { db, run, hindu } = setUp();
    const bo = guestNamed(db, "Bo");
    db.update(guests).set({ lastName: "" }).where(eq(guests.id, bo.id)).run();
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });

    const view = hindu(await run(rsvpExportService.buildView(BOOTSTRAP_WEDDING_ID)));
    expect(view.unresponded.find((g) => g.guestId === samId)?.plusOneOfName).toBe("Bo");
    const data = await run(rsvpExportService.build(BOOTSTRAP_WEDDING_ID));
    expect(data.rows.find((r) => r.firstName === "Sam")?.plusOneOfName).toBe("Bo");
  });
});
