import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guestEvents, guests, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { tableExportService } from "./table-export";

const withDb = effWith(TestDbLayer);

/** Split a CSV document into lines (CRLF, per RFC 4180). */
const lines = (csv: string) => csv.split("\r\n");

describe("tableExportService.guestsCsv", () => {
  it(
    "exports one row per guest under a header, sorted by family code",
    withDb(
      Effect.gen(function* () {
        const csv = yield* tableExportService.guestsCsv(BOOTSTRAP_WEDDING_ID);
        const rows = lines(csv);
        // Header + the seed's 6 guests.
        expect(rows).toHaveLength(7);
        expect(rows[0]).toBe(
          "Family Code,Family Name,Guest First Name,Guest Last Name,Events,Invite Sent At,Invite Opened At,Code Status",
        );
        const codes = rows.slice(1).map((r) => r.split(",")[0]!);
        expect(codes).toEqual([...codes].toSorted());
      }),
    ),
  );

  it(
    "lists invited event NAMES chronologically and defaults Code Status to Active",
    withDb(
      Effect.gen(function* () {
        const csv = yield* tableExportService.guestsCsv(BOOTSTRAP_WEDDING_ID);
        const ada = lines(csv).find((r) => r.includes("Ada"));
        // Ada is invited to catholic + hindu + reception (see seed) — names,
        // not ids, in start-time order, "; "-joined.
        expect(ada).toContain("Catholic Ceremony; Hindu Ceremony; Reception");
        expect(ada).toContain("Active");
      }),
    ),
  );

  it(
    "surfaces Sent/Opened timestamps and a Deactivated code status",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const fam = db
          .select({ id: families.id, publicId: families.publicId })
          .from(families)
          .all()[0]!;
        const sent = new Date("2026-06-01T00:00:00Z");
        const opened = new Date("2026-06-02T00:00:00Z");
        db.update(families)
          .set({ codeSharedAt: sent, firstOpenedAt: opened, deactivatedAt: new Date() })
          .where(eq(families.id, fam.id))
          .run();

        const csv = yield* tableExportService.guestsCsv(BOOTSTRAP_WEDDING_ID);
        const row = lines(csv).find((r) => r.startsWith(fam.publicId))!;
        expect(row).toContain("2026-06-01T00:00:00.000Z");
        expect(row).toContain("2026-06-02T00:00:00.000Z");
        expect(row).toContain("Deactivated");
      }),
    ),
  );

  it(
    "excludes host-kind families and neutralises formula cells",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
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
        // A guest-supplied formula in a name cell must come out defused.
        const someGuest = db.select({ id: guests.id }).from(guests).all()[0]!;
        db.update(guests).set({ firstName: "=EVIL()" }).where(eq(guests.id, someGuest.id)).run();

        const csv = yield* tableExportService.guestsCsv(BOOTSTRAP_WEDDING_ID);
        expect(csv).not.toContain("Hosty");
        expect(csv).not.toContain("HOST-AAAA");
        expect(csv).toContain("'=EVIL()");
        expect(csv).not.toContain(",=EVIL()");
      }),
    ),
  );

  it(
    "still lists a guest with no event invites (blank Events cell)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        // A household imported but not yet linked to any event — the exact
        // population the roster export exists to chase. Left-join semantics
        // must keep them in the file.
        db.insert(families)
          .values({
            id: "fam_solo",
            weddingId: BOOTSTRAP_WEDDING_ID,
            publicId: "ZZSOLO-AAAA",
            familyName: "Solofam",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(guests)
          .values({
            id: "gst_solo",
            familyId: "fam_solo",
            firstName: "Sana",
            lastName: "Solo",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();

        const csv = yield* tableExportService.guestsCsv(BOOTSTRAP_WEDDING_ID);
        const row = lines(csv).find((r) => r.startsWith("ZZSOLO-AAAA"));
        // Empty Events + Sent + Opened cells, Active status.
        expect(row).toBe("ZZSOLO-AAAA,Solofam,Sana,Solo,,,,Active");
      }),
    ),
  );

  it(
    "returns a header-only CSV for a wedding with no guests",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        db.insert(weddings)
          .values({
            id: "wed_empty",
            slug: "empty-wedding",
            displayName: "Empty Wedding",
            ownerOsnProfileId: "usr_empty",
            createdAt: now,
            updatedAt: now,
          })
          .run();

        const csv = yield* tableExportService.guestsCsv("wed_empty");
        expect(lines(csv)).toEqual([
          "Family Code,Family Name,Guest First Name,Guest Last Name,Events,Invite Sent At,Invite Opened At,Code Status",
        ]);
      }),
    ),
  );
});

describe("tableExportService.eventsCsv", () => {
  it(
    "exports one row per event, chronologically, with details + palette",
    withDb(
      Effect.gen(function* () {
        const csv = yield* tableExportService.eventsCsv(BOOTSTRAP_WEDDING_ID);
        const rows = lines(csv);
        // Header + the seed's 5 events.
        expect(rows).toHaveLength(6);
        expect(rows[0]).toBe(
          "Event Name,Slug,Starts At,Ends At,Timezone,Address,Description,Dress Code,Dress Code Palette,Pinterest URL,Maps URL,Invited Guests",
        );
        const names = rows.slice(1).map((r) => r.split(",")[0]!);
        expect(names).toEqual([
          "Catholic Ceremony",
          "Kitchen Tea",
          "Mehendi",
          "Hindu Ceremony",
          "Reception",
        ]);
        // Swatches render as `Name (color)` pairs.
        expect(rows[1]).toContain("Blush (oklch(86.50% 0.0480 12.50))");
        expect(rows[1]).toContain("123 Example St");
      }),
    ),
  );

  it(
    "counts invited guests per event (host families excluded)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const catholic = db.select().from(events).where(eq(events.slug, "catholic")).all()[0]!;
        const expected = db
          .select()
          .from(guestEvents)
          .where(eq(guestEvents.eventId, catholic.id))
          .all().length;

        const csv = yield* tableExportService.eventsCsv(BOOTSTRAP_WEDDING_ID);
        const row = lines(csv).find((r) => r.startsWith("Catholic Ceremony"))!;
        const invited = row.slice(row.lastIndexOf(",") + 1);
        expect(invited).toBe(String(expected));
        expect(expected).toBeGreaterThan(0);
      }),
    ),
  );

  it(
    "drops non-http(s) URLs instead of exporting them",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const catholic = db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.slug, "catholic"))
          .all()[0]!;
        db.update(events)
          .set({ pinterestUrl: "javascript:alert(1)" })
          .where(eq(events.id, catholic.id))
          .run();

        const csv = yield* tableExportService.eventsCsv(BOOTSTRAP_WEDDING_ID);
        expect(csv).not.toContain("javascript:alert(1)");
      }),
    ),
  );

  it(
    "renders an empty palette cell for a malformed dress_code_palette (export never breaks)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        db.update(events)
          .set({ dressCodePalette: "{not json" })
          .where(eq(events.slug, "catholic"))
          .run();

        const csv = yield* tableExportService.eventsCsv(BOOTSTRAP_WEDDING_ID);
        const rows = lines(csv);
        // All 5 events still export; the corrupt palette degrades to blank.
        expect(rows).toHaveLength(6);
        const row = rows.find((r) => r.startsWith("Catholic Ceremony"))!;
        expect(row).not.toContain("Blush");
        expect(row).not.toContain("undefined");
        expect(row).not.toContain("null");
      }),
    ),
  );

  it(
    "returns a header-only CSV for a wedding with no events",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        db.insert(weddings)
          .values({
            id: "wed_empty",
            slug: "empty-wedding",
            displayName: "Empty Wedding",
            ownerOsnProfileId: "usr_empty",
            createdAt: now,
            updatedAt: now,
          })
          .run();

        const csv = yield* tableExportService.eventsCsv("wed_empty");
        expect(lines(csv)).toEqual([
          "Event Name,Slug,Starts At,Ends At,Timezone,Address,Description,Dress Code,Dress Code Palette,Pinterest URL,Maps URL,Invited Guests",
        ]);
      }),
    ),
  );
});
