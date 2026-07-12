import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guestEvents, guests, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import type { ParsedFamily } from "../schemas/import";
import { effWith } from "../test-helpers";
import { diffAgainstDb } from "./import";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";
import { stateExportService } from "./state-export";

const withDb = effWith(TestDbLayer);

/** Split a CSV document into lines (CRLF, per RFC 4180). */
const lines = (csv: string) => csv.split("\r\n");

describe("stateExportService.eventsCsv", () => {
  it(
    "writes the exact import-template header row",
    withDb(
      Effect.gen(function* () {
        const csv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID);
        // Byte-for-byte lockstep with the organiser template + parser — a
        // rename in lib/sheet-headers.ts must fail here.
        expect(lines(csv)[0]).toBe(
          "Event Name,Start,Timezone,End,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
        );
      }),
    ),
  );

  it(
    "exports one row per event in sortOrder order with palette cells in sheet format",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const seeded = db
          .select({ name: events.name, sortOrder: events.sortOrder })
          .from(events)
          .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
          .all()
          .toSorted((a, b) => a.sortOrder - b.sortOrder);

        const csv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID);
        const rows = lines(csv).slice(1);
        expect(rows).toHaveLength(seeded.length);
        seeded.forEach((e, i) => {
          // Quoted-cell safe: just assert the row leads with the name.
          expect(rows[i]!.startsWith(e.name) || rows[i]!.startsWith(`"${e.name}`)).toBe(true);
        });
        // Palette cells (when present) use the sheet's Name:#rgb|Name:#rgb form,
        // never raw JSON.
        expect(csv).not.toContain('[{"name"');
      }),
    ),
  );

  it(
    "appends the Event ID column under fidelity=full",
    withDb(
      Effect.gen(function* () {
        const csv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, "full");
        expect(lines(csv)[0]!.endsWith(",Event ID")).toBe(true);
        const db = yield* DbService;
        const [anyEvent] = db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
          .all();
        expect(csv).toContain(anyEvent!.id);
      }),
    ),
  );
});

describe("stateExportService.guestsCsv", () => {
  it(
    "writes the fixed + nickname headers then one column per event, and neutral fam-NNN ids",
    withDb(
      Effect.gen(function* () {
        const csv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID);
        const header = lines(csv)[0]!;
        expect(
          header.startsWith(
            "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Nickname,",
          ),
        ).toBe(true);
        // Standard fidelity: neutral grouping keys, NO claim codes, no UUIDs.
        expect(lines(csv)[1]!.startsWith("fam-001,")).toBe(true);
        const db = yield* DbService;
        const codes = db
          .select({ publicId: families.publicId })
          .from(families)
          .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
          .all();
        for (const c of codes) expect(csv).not.toContain(c.publicId);
      }),
    ),
  );

  it(
    "appends Family Code + Guest ID under fidelity=full and uses internal family ids",
    withDb(
      Effect.gen(function* () {
        const csv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, "full");
        expect(lines(csv)[0]!.endsWith(",Family Code,Guest ID")).toBe(true);
        const db = yield* DbService;
        const fams = db
          .select({ id: families.id, publicId: families.publicId })
          .from(families)
          .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
          .all();
        for (const f of fams) {
          expect(csv).toContain(f.id);
          expect(csv).toContain(f.publicId);
        }
      }),
    ),
  );

  it(
    "excludes host-preview families",
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
        const csv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, "full");
        expect(csv).not.toContain("Hosty");
        expect(csv).not.toContain("HOST-AAAA");
      }),
    ),
  );
});

describe("round trip: export → parse → diff is a fixpoint", () => {
  const assertFixpoint = (fidelity: "import" | "full") =>
    withDb(
      Effect.gen(function* () {
        const eventsCsv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, fidelity);
        const guestsCsv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, fidelity);

        // The exported sheets must parse with the REAL import parser…
        const parsedEvents = yield* parseEventsCsv(eventsCsv);
        const parsedFamilies = yield* parseGuestsCsv(guestsCsv, parsedEvents);

        // …and reconciling them against the DB they came from must change
        // nothing: no creates, no removes, no guest/link deltas. (The diff
        // unconditionally emits an idempotent eventUpdate per matched event —
        // assert the values are identical instead of the list being empty.)
        const plan = yield* diffAgainstDb(
          parsedEvents,
          parsedFamilies as ParsedFamily[],
          BOOTSTRAP_WEDDING_ID,
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
        expect(plan.warnings).toHaveLength(0);

        const db = yield* DbService;
        for (const eu of plan.eventUpdates) {
          const [row] = db.select().from(events).where(eq(events.id, eu.id)).all();
          expect(eu.event.name).toBe(row!.name);
          expect(eu.event.startAt).toBe(row!.startAt);
          expect(eu.event.endAt).toBe(row!.endAt);
          expect(eu.event.timezone).toBe(row!.timezone);
          expect(eu.event.address ?? null).toBe(row!.address);
          expect(eu.event.dressCodeDescription ?? null).toBe(row!.dressCodeDescription);
          expect(JSON.stringify(eu.event.dressCodePalette)).toBe(row!.dressCodePalette);
          expect(eu.event.sortOrder).toBe(row!.sortOrder);
        }
      }),
    );

  it("holds at import fidelity", assertFixpoint("import"));
  // fidelity=full adds the ID/code columns — the parser must accept-and-ignore
  // them (they are fixed columns, never mistaken for event columns).
  it("holds at full fidelity", assertFixpoint("full"));
});

describe("round trip: hostile + sparse inputs (T-S1/T-S2)", () => {
  it(
    "survives events named after the fidelity columns and sparse optional fields, at both fidelities",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        // T-S1: event names colliding with the reserved fidelity headers. The
        // guests parser must keep their attendance columns (only the LAST
        // occurrence — the exporter-appended fidelity column — is ignored).
        db.insert(events)
          .values({
            id: "evt_guest_id",
            weddingId: BOOTSTRAP_WEDDING_ID,
            slug: "guest-id",
            name: "Guest ID",
            description: "",
            startAt: "2026-12-01T10:00:00+11:00",
            endAt: "",
            timezone: "Australia/Sydney",
            sortOrder: 90,
          })
          .run();
        db.insert(events)
          .values({
            id: "evt_family_code",
            weddingId: BOOTSTRAP_WEDDING_ID,
            slug: "family-code",
            name: "Family Code",
            description: "",
            // T-S2: open-ended "" endAt sentinel + null address/URLs/palette.
            startAt: "2026-12-02T10:00:00+11:00",
            endAt: "",
            timezone: "Australia/Sydney",
            sortOrder: 91,
          })
          .run();
        // Invite an existing guest to both colliding events — the links are
        // exactly what T-S1's silent-drop bug would lose.
        const [someGuest] = db
          .select({ id: guests.id })
          .from(guests)
          .innerJoin(families, eq(guests.familyId, families.id))
          .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
          .all();
        db.insert(guestEvents).values({ guestId: someGuest!.id, eventId: "evt_guest_id" }).run();
        db.insert(guestEvents).values({ guestId: someGuest!.id, eventId: "evt_family_code" }).run();
        // T-S2: a non-null nickname must round-trip too.
        db.update(guests).set({ nickname: "Nicky" }).where(eq(guests.id, someGuest!.id)).run();

        for (const fidelity of ["import", "full"] as const) {
          const eventsCsv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, fidelity);
          const guestsCsv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, fidelity);
          const parsedEvents = yield* parseEventsCsv(eventsCsv);
          const parsedFamilies = yield* parseGuestsCsv(guestsCsv, parsedEvents);
          const plan = yield* diffAgainstDb(
            parsedEvents,
            parsedFamilies as ParsedFamily[],
            BOOTSTRAP_WEDDING_ID,
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
          // The "" end sentinel survived the round trip.
          const sparse = plan.eventUpdates.find((eu) => eu.id === "evt_family_code")!;
          expect(sparse.event.endAt).toBe("");
          expect(sparse.event.address).toBeNull();
        }
      }),
    ),
  );
});

describe("defensive normalisation (T-S3)", () => {
  it(
    "strips palette delimiters and drops non-http(s) URLs so the export stays importable",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const [anyEvent] = db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
          .all();
        // Hostile values a future writer (the E5 editor) could store — the
        // import parser could never have produced these.
        db.update(events)
          .set({
            dressCodePalette: JSON.stringify([{ name: "Blue|Gold: dusk", color: "#123456" }]),
            pinterestUrl: "javascript:alert(1)",
          })
          .where(eq(events.id, anyEvent!.id))
          .run();

        const csv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID);
        const parsed = yield* parseEventsCsv(csv);
        const row = db.select().from(events).where(eq(events.id, anyEvent!.id)).all()[0]!;
        const reParsed = parsed.find((e) => e.name === row.name)!;
        // Still ONE swatch (delimiters stripped, not split into extra swatches)
        // with the colour intact, and the unsafe URL exported as blank.
        expect(reParsed.dressCodePalette).toHaveLength(1);
        expect(reParsed.dressCodePalette[0]!.color).toBe("#123456");
        expect(reParsed.pinterestUrl).toBeNull();
      }),
    ),
  );
});

describe("empty wedding (T-S4)", () => {
  it(
    "exports header-only sheets for a wedding with no events or guests",
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

        const eventsCsv = yield* stateExportService.eventsCsv("wed_empty");
        const guestsCsv = yield* stateExportService.guestsCsv("wed_empty");
        expect(lines(eventsCsv)).toHaveLength(1);
        expect(lines(guestsCsv)).toHaveLength(1);
        // With zero events there are no attendance columns — just the fixed
        // guest columns + nickname.
        expect(lines(guestsCsv)[0]).toBe(
          "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Nickname",
        );
        // Both empty sheets still parse (the parser rejects zero ROWS, not
        // zero data rows).
        const parsedEvents = yield* parseEventsCsv(eventsCsv);
        expect(parsedEvents).toHaveLength(0);
        const parsedFamilies = yield* parseGuestsCsv(guestsCsv, parsedEvents);
        expect(parsedFamilies).toHaveLength(0);
      }),
    ),
  );
});
