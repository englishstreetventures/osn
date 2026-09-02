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
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { Db } from "../../src/db";
import { DbService } from "../../src/db";
import { rsvpExportService, toCsv, sanitiseCsvCell } from "../../src/services/rsvp-export";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";

const withDb = effWith(TestDbLayer);

/** The export's own name for an event — the CSV header is built from it. */
function eventName(data: { events: { id: string; name: string }[] }, eventId: string): string {
  return data.events.find((e) => e.id === eventId)!.name;
}

/** Insert an RSVP row for a guest+event. */
function rsvp(
  db: Db,
  guestId: string,
  eventId: string,
  status: "attending" | "declined" | "maybe",
  dietary = "",
  consentSource: "guest" | "organiser_attested" = "guest",
) {
  db.insert(rsvps)
    .values({
      id: crypto.randomUUID(),
      guestId,
      eventId,
      status,
      dietary,
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
    "emits the fixed columns + a status/dietary PAIR per event + Recorded By",
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
        // One trailing column: writer provenance (0037). The aggregate
        // "Dietary Requirements" column is gone — it could only show one of a
        // guest's per-event answers.
        expect(header[header.length - 1]).toBe("Recorded By");
        expect(header).not.toContain("Dietary Requirements");
        // Each event contributes a PAIR, interleaved so the caterer for one
        // event reads its status and its dietary note side by side.
        expect(header.slice(4, -1)).toEqual(
          data.events.flatMap((e) => [e.name, `${e.name} Dietary`]),
        );
        expect(header.length).toBe(4 + data.events.length * 2 + 1);
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
