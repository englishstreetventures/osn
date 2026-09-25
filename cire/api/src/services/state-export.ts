import { events, families, guestEvents, guests } from "@cire/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { serialiseCsv } from "../lib/csv";
import { formatWallTime } from "../lib/event-time";
import {
  EVENT_ID_HEADER,
  EVENT_SHEET_HEADERS,
  FAMILY_CODE_HEADER,
  GUEST_ID_HEADER,
  GUEST_NICKNAME_HEADER,
  GUEST_SHEET_FIXED_HEADERS,
} from "../lib/sheet-headers";
import { decodePalette, safeHttpUrl } from "./claim";
import { MAX_ROWS } from "./spreadsheet";

/**
 * Round-trip exports: the wedding's CURRENT events + guests serialised in the
 * IMPORT template schema, so a download can be edited in any spreadsheet tool
 * and re-uploaded through the import — and so the E3 checkpoint writer can
 * snapshot state in the same format the reconcile pipeline reads. Companion to
 * the reporting exports in `table-export.ts` (dashboard-shaped, NOT
 * re-importable); same wedding scoping, host-family exclusion, and shared
 * serialiser (`lib/csv.ts`). See [[guest-event-editor]] §5.
 *
 * Fidelity:
 *  - `"import"` (default) — exactly the organiser template columns. `Family ID`
 *    carries neutral sequential `fam-001` grouping keys (the parser ignores the
 *    column; claim codes are deliberately NOT included at this level).
 *  - `"full"` — appends the fidelity columns: `Event ID` (events sheet),
 *    `Guest ID` + `Family Code` (guests sheet), and `Family ID` carries the
 *    internal family id. The parser honours them, so a re-import matches rows by
 *    id. A full download contains live claim codes.
 *  - `"snapshot"` — what the checkpoint writes as a change's before-image, and
 *    never a download: `"full"`, plus one household-only row (Family ID, Family
 *    Name and Family Code set, every guest cell blank) for each household that
 *    has no guests. Only the revert's reader (`parseGuestsCsv` with
 *    `{ snapshot: true }`) accepts those rows; the upload parser refuses them.
 */
export type ExportFidelity = "import" | "full" | "snapshot";

/**
 * Format a decoded palette back into the sheet's `Name:#rgb|Name:#rgb` cell.
 * Import-written names can never contain `|`/`:` (the parser splits on them),
 * but future writers might — strip the delimiters so the cell always re-parses
 * to the same swatch count.
 */
function paletteCell(raw: string | null): string {
  const { palette } = decodePalette(raw);
  if (!palette || palette.length === 0) return "";
  return palette
    .map((s) => `${s.name.replace(/[|:]/g, " ").trim()}:${s.color.replace(/\|/g, " ").trim()}`)
    .join("|");
}

export const stateExportService = {
  /**
   * Events sheet: one row per event in `sortOrder` order — the parser assigns
   * `sortOrder` from row order, so exporting in that order makes the
   * re-imported ordering a fixpoint. `Location` is always blank (the venue text
   * lives in `Address`; the import only reads Location as an Address fallback).
   * URLs pass the http(s) guard so a legacy non-http value can't make the
   * exported sheet un-importable.
   */
  eventsCsv(
    weddingId: string,
    fidelity: ExportFidelity = "import",
  ): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select()
          .from(events)
          .where(eq(events.weddingId, weddingId))
          .orderBy(asc(events.sortOrder), asc(events.name))
          .all(),
      );

      const withIds = fidelity !== "import";
      const header = withIds ? [...EVENT_SHEET_HEADERS, EVENT_ID_HEADER] : [...EVENT_SHEET_HEADERS];
      const data = rows.map((e) => {
        const cells = [
          e.name,
          // Wall clock only. This sheet is meant to be edited and re-uploaded,
          // and the import schema asks for local time + a Timezone column — the
          // stored offset is derived from that zone (`lib/event-time.ts`), so
          // exporting it would put a number in front of the organiser that they
          // can neither meaningfully change nor be trusted to keep in step with
          // the zone. Re-importing stamps it back.
          formatWallTime(e.startAt),
          e.timezone,
          formatWallTime(e.endAt), // "" sentinel exports as a blank optional End
          "", // Location — venue text lives in Address
          e.address ?? "",
          e.dressCodeDescription ?? "",
          paletteCell(e.dressCodePalette),
          safeHttpUrl(e.pinterestUrl) ?? "",
          safeHttpUrl(e.mapsUrl) ?? "",
        ];
        if (withIds) cells.push(e.id);
        return cells;
      });

      return serialiseCsv(header, data);
    }).pipe(Effect.withSpan("cire.state-export.eventsCsv"));
  },

  /**
   * Guests sheet: one row per guest, grouped by household (families ordered by
   * name, guests by their seeded `sortOrder` — the parser reassigns `sortOrder`
   * from row order, so this too is a fixpoint), with one attendance column per
   * event (in the events sheet's order) marked with the parser-truthy `x`.
   * Host-preview families are excluded, as everywhere else. At `"snapshot"`
   * fidelity a household with no guests gets a household-only row in its place
   * in the order.
   */
  guestsCsv(
    weddingId: string,
    fidelity: ExportFidelity = "import",
  ): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const withIds = fidelity !== "import";
      const snapshot = fidelity === "snapshot";

      const householdScope = and(eq(families.weddingId, weddingId), ne(families.kind, "host"));
      const guestColumns = {
        guestId: guests.id,
        firstName: guests.firstName,
        lastName: guests.lastName,
        nickname: guests.nickname,
        sortOrder: guests.sortOrder,
        familyId: families.id,
        familyName: families.familyName,
        publicId: families.publicId,
      };

      // The reads are independently wedding-scoped — collapse them to one D1
      // round-trip (matches the parallel shape in table-export.ts and
      // rsvp-export.ts).
      const [eventRows, householdRows, linkRows] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({ id: events.id, name: events.name })
              .from(events)
              .where(eq(events.weddingId, weddingId))
              .orderBy(asc(events.sortOrder), asc(events.name))
              .all(),
          ),
          // One row per guest with its household. A snapshot also needs the
          // households that have no guest, so it reads from `families` with a
          // left join: a guest-less household comes back once, guest columns
          // null. Every other level keeps the inner join it has always run.
          snapshot
            ? dbQuery(() =>
                db
                  .select(guestColumns)
                  .from(families)
                  .leftJoin(guests, eq(guests.familyId, families.id))
                  .where(householdScope)
                  .all(),
              )
            : dbQuery(() =>
                db
                  .select(guestColumns)
                  .from(guests)
                  .innerJoin(families, eq(guests.familyId, families.id))
                  .where(householdScope)
                  .all(),
              ),
          // Wedding-scoped through guests → families, mirroring the import diff —
          // guest_events carries no wedding_id of its own.
          dbQuery(() =>
            db
              .select({ guestId: guestEvents.guestId, eventId: guestEvents.eventId })
              .from(guestEvents)
              .innerJoin(guests, eq(guestEvents.guestId, guests.id))
              .innerJoin(families, eq(guests.familyId, families.id))
              .where(householdScope)
              .all(),
          ),
        ],
        { concurrency: 3 },
      );
      const invited = new Set(linkRows.map((l) => `${l.guestId}::${l.eventId}`));

      // Group rows into households, then order deterministically: families by
      // case-insensitive name, guests by seeded sortOrder (then id for ties).
      interface Guest {
        readonly guestId: string;
        readonly firstName: string;
        readonly lastName: string;
        readonly nickname: string | null;
        readonly sortOrder: number;
      }
      interface Household {
        readonly familyId: string;
        readonly familyName: string;
        readonly publicId: string;
        readonly guests: Guest[];
      }
      const byFamily = new Map<string, Household>();
      for (const row of householdRows) {
        let household = byFamily.get(row.familyId);
        if (!household) {
          household = {
            familyId: row.familyId,
            familyName: row.familyName,
            publicId: row.publicId,
            guests: [],
          };
          byFamily.set(row.familyId, household);
        }
        // Null only on the snapshot's left join, for a household with no guest.
        if (row.guestId === null || row.firstName === null || row.lastName === null) continue;
        household.guests.push({
          guestId: row.guestId,
          firstName: row.firstName,
          lastName: row.lastName,
          nickname: row.nickname,
          sortOrder: row.sortOrder ?? 0,
        });
      }
      const householdKey = (h: Household) => h.familyName.trim().toLowerCase();
      const households = [...byFamily.values()].toSorted((a, b) => {
        const ka = householdKey(a);
        const kb = householdKey(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      for (const h of households) {
        h.guests.sort((a, b) => a.sortOrder - b.sortOrder || (a.guestId < b.guestId ? -1 : 1));
      }

      const header = [
        ...GUEST_SHEET_FIXED_HEADERS,
        GUEST_NICKNAME_HEADER,
        ...eventRows.map((e) => e.name),
        ...(withIds ? [FAMILY_CODE_HEADER, GUEST_ID_HEADER] : []),
      ];

      const data: string[][] = [];
      households.forEach((h, familyIndex) => {
        const familyKey = withIds ? h.familyId : `fam-${String(familyIndex + 1).padStart(3, "0")}`;
        if (h.guests.length === 0) {
          // Only a snapshot reads guest-less households, so only it has any.
          data.push([
            familyKey,
            h.familyName,
            "",
            "",
            "",
            ...eventRows.map(() => ""),
            h.publicId,
            "",
          ]);
          return;
        }
        for (const g of h.guests) {
          const cells = [
            familyKey,
            h.familyName,
            g.firstName,
            g.lastName,
            g.nickname ?? "",
            ...eventRows.map((e) => (invited.has(`${g.guestId}::${e.id}`) ? "x" : "")),
          ];
          if (withIds) cells.push(h.publicId, g.guestId);
          data.push(cells);
        }
      });

      // Warn when the produced guest-row count exceeds MAX_ROWS so the
      // "export > what import re-accepts" case is visible before an organiser
      // hits it (the import parser caps both sheets at MAX_ROWS and rejects the
      // upload). Snapshot semantics require the full export — no pagination — so
      // this is observability only, never a hard cap.
      if (data.length > MAX_ROWS) {
        yield* Effect.logWarning("state export exceeds import row cap", {
          exportedRows: data.length,
          importCap: MAX_ROWS,
          weddingId,
        });
      }

      return serialiseCsv(header, data);
    }).pipe(Effect.withSpan("cire.state-export.guestsCsv"));
  },
};
