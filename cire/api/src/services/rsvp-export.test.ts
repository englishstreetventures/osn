import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guests, rsvps, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { Db } from "../db";
import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { rsvpExportService, toCsv, sanitiseCsvCell } from "./rsvp-export";

const withDb = effWith(TestDbLayer);

/** Insert an RSVP row for a guest+event. */
function rsvp(
  db: Db,
  guestId: string,
  eventId: string,
  status: "attending" | "declined" | "maybe",
  dietary = "",
) {
  db.insert(rsvps)
    .values({
      id: crypto.randomUUID(),
      guestId,
      eventId,
      status,
      dietary,
      createdAt: new Date(),
    })
    .run();
}

/** A guest by first name in the bootstrap wedding (seed mints random ids). */
function guestByName(db: Db, firstName: string): { id: string } {
  const row = db
    .select({ id: guests.id })
    .from(guests)
    .where(eq(guests.firstName, firstName))
    .all()[0];
  if (!row) throw new Error(`no guest named ${firstName}`);
  return row;
}

/** An event id by slug. */
function eventBySlug(db: Db, slug: string): { id: string } {
  const row = db.select({ id: events.id }).from(events).where(eq(events.slug, slug)).all()[0];
  if (!row) throw new Error(`no event ${slug}`);
  return row;
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
        const startById = new Map(
          db
            .select({ id: events.id, startAt: events.startAt })
            .from(events)
            .all()
            .map((e) => [e.id, e.startAt]),
        );
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
        const ada = guestByName(db, "Ada");
        const catholic = eventBySlug(db, "catholic");
        const hindu = eventBySlug(db, "hindu");
        const reception = eventBySlug(db, "reception");

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
        const kitchenTea = eventBySlug(db, "kitchen-tea");
        expect(cellFor(kitchenTea.id)).toBe("not_invited");
      }),
    ),
  );

  it(
    "maps the schema 'maybe' status to a distinct maybe cell",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = guestByName(db, "Ada");
        const reception = eventBySlug(db, "reception");
        rsvp(db, ada.id, reception.id, "maybe");
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada")!;
        const cell = adaRow.cells[data.events.findIndex((e) => e.id === reception.id)];
        expect(cell).toBe("maybe");
      }),
    ),
  );

  it(
    "surfaces the guest's dietary requirement",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = guestByName(db, "Ada");
        const catholic = eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "attending", "Vegetarian, no nuts");
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const adaRow = data.rows.find((r) => r.firstName === "Ada")!;
        expect(adaRow.dietary).toBe("Vegetarian, no nuts");
        // A guest with no dietary note has a blank dietary cell.
        const other = data.rows.find((r) => r.firstName !== "Ada" && r.dietary === "");
        expect(other).toBeDefined();
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
    "emits the fixed columns + one column per event + Dietary Requirements",
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
        expect(header[header.length - 1]).toBe("Dietary Requirements");
        // One column per event sits between the fixed leading + trailing columns.
        expect(header.length).toBe(4 + data.events.length + 1);
      }),
    ),
  );

  it(
    "renders cell labels in CSV (Attending / Not attending / No response / blank)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = guestByName(db, "Ada");
        const catholic = eventBySlug(db, "catholic");
        const hindu = eventBySlug(db, "hindu");
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
        const ada = guestByName(db, "Ada");
        const catholic = eventBySlug(db, "catholic");
        rsvp(db, ada.id, catholic.id, "attending", "Vegetarian, no nuts");
        const data = yield* rsvpExportService.build(BOOTSTRAP_WEDDING_ID);
        const csv = toCsv(data);
        expect(csv).toContain('"Vegetarian, no nuts"');
      }),
    ),
  );
});
