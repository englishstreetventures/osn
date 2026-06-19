import { families, guests, events, guestEvents, rsvps } from "@cire/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";

/**
 * Per-guest per-event RSVP cell. Distinguishes four states an organiser cares
 * about when chasing responses:
 *  - "not_invited" — the guest isn't on this event's invite list (no
 *    `guest_events` row). Rendered as a BLANK cell, never "No response".
 *  - "no_response" — invited but hasn't RSVP'd to this event yet.
 *  - "attending"   — RSVP'd `attending`.
 *  - "not_attending" — RSVP'd `declined`.
 *  - "maybe"       — RSVP'd `maybe` (the schema's third status; kept distinct so
 *    the export never silently reports a "maybe" as a firm yes/no).
 *
 * The DB `rsvps.status` enum is `attending | declined | maybe`; this maps it to
 * the human-facing cell label below.
 */
export type EventCell = "not_invited" | "no_response" | "attending" | "not_attending" | "maybe";

/** One exported row per guest (including guests who haven't RSVP'd at all). */
export interface RsvpExportRow {
  familyCode: string;
  familyName: string;
  firstName: string;
  lastName: string;
  /** RSVP cell per event, in the same order as `RsvpExport.events`. */
  cells: EventCell[];
  /** Dietary requirements text — blank unless the guest is attending an event
   *  with a non-empty dietary note. */
  dietary: string;
}

export interface RsvpExportEvent {
  id: string;
  name: string;
}

export interface RsvpExport {
  /** Events ordered by start time (then sortOrder, then id) — one CSV column each. */
  events: RsvpExportEvent[];
  /** Guest rows, ordered alphabetically by family code, stable within a family. */
  rows: RsvpExportRow[];
}

/** Human-facing label for each cell state (the value written into the CSV). */
const CELL_LABEL: Record<EventCell, string> = {
  not_invited: "",
  no_response: "No response",
  attending: "Attending",
  not_attending: "Not attending",
  maybe: "Maybe",
};

function mapStatus(status: "attending" | "declined" | "maybe"): EventCell {
  if (status === "attending") return "attending";
  if (status === "declined") return "not_attending";
  return "maybe";
}

export const rsvpExportService = {
  /**
   * Build the RSVP export for one wedding. weddingId is required — an unscoped
   * variant would be a cross-tenant leak (mirrors `getAllGuests`). Host-kind
   * families (the organiser's own preview family) are excluded with the same
   * `ne(families.kind, "host")` filter the guest roster uses.
   *
   * ONE ROW PER GUEST, including guests with no RSVP at all. Ordered
   * alphabetically by family code (`families.public_id`), stable within a family
   * (by guest `sort_order`, then id).
   */
  build(weddingId: string): Effect.Effect<RsvpExport, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // (a) Events for the wedding, ordered by start time. `start_at` is an
      // ISO-8601 string with offset, so lexicographic order is NOT reliable
      // across timezones — sort in JS by parsed epoch, falling back to
      // sort_order then id for ties / unparseable timestamps.
      const eventRows = yield* dbQuery(() =>
        db
          .select({
            id: events.id,
            name: events.name,
            startAt: events.startAt,
            sortOrder: events.sortOrder,
          })
          .from(events)
          .where(eq(events.weddingId, weddingId))
          .all(),
      );

      const orderedEvents = eventRows.toSorted((a, b) => {
        const ta = Date.parse(a.startAt);
        const tb = Date.parse(b.startAt);
        const aValid = !Number.isNaN(ta);
        const bValid = !Number.isNaN(tb);
        if (aValid && bValid && ta !== tb) return ta - tb;
        if (aValid !== bValid) return aValid ? -1 : 1;
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      // (b) Guests + family + their event memberships (left join → a guest with
      // no invites still appears). Host families excluded.
      const guestRows = yield* dbQuery(() =>
        db
          .select({
            guestId: guests.id,
            firstName: guests.firstName,
            lastName: guests.lastName,
            sortOrder: guests.sortOrder,
            publicId: families.publicId,
            familyName: families.familyName,
            eventId: guestEvents.eventId,
          })
          .from(guests)
          .innerJoin(families, eq(guests.familyId, families.id))
          .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
          .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
          .orderBy(asc(guests.sortOrder))
          .all(),
      );

      interface GuestAcc {
        guestId: string;
        firstName: string;
        lastName: string;
        sortOrder: number;
        publicId: string;
        familyName: string;
        invited: Set<string>;
      }
      const byGuest = new Map<string, GuestAcc>();
      for (const row of guestRows) {
        let acc = byGuest.get(row.guestId);
        if (!acc) {
          acc = {
            guestId: row.guestId,
            firstName: row.firstName,
            lastName: row.lastName,
            sortOrder: row.sortOrder,
            publicId: row.publicId,
            familyName: row.familyName,
            invited: new Set<string>(),
          };
          byGuest.set(row.guestId, acc);
        }
        if (row.eventId !== null) acc.invited.add(row.eventId);
      }

      // (c) RSVPs for the wedding's guests (scoped via the guest→family join so
      // a host family's preview RSVPs, if any, never leak in).
      const rsvpRows = yield* dbQuery(() =>
        db
          .select({
            guestId: rsvps.guestId,
            eventId: rsvps.eventId,
            status: rsvps.status,
            dietary: rsvps.dietary,
          })
          .from(rsvps)
          .innerJoin(guests, eq(rsvps.guestId, guests.id))
          .innerJoin(families, eq(guests.familyId, families.id))
          .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
          .all(),
      );

      // guestId → eventId → {status, dietary}
      const rsvpByGuest = new Map<
        string,
        Map<string, { status: "attending" | "declined" | "maybe"; dietary: string }>
      >();
      for (const row of rsvpRows) {
        let perGuest = rsvpByGuest.get(row.guestId);
        if (!perGuest) {
          perGuest = new Map();
          rsvpByGuest.set(row.guestId, perGuest);
        }
        perGuest.set(row.eventId, { status: row.status, dietary: row.dietary });
      }

      const rows: RsvpExportRow[] = [];
      for (const g of byGuest.values()) {
        const cells: EventCell[] = orderedEvents.map((e) => {
          if (!g.invited.has(e.id)) return "not_invited";
          const rsvp = rsvpByGuest.get(g.guestId)?.get(e.id);
          if (!rsvp) return "no_response";
          return mapStatus(rsvp.status);
        });

        // Dietary: the guest's non-empty dietary note from any of their RSVPs.
        // A guest RSVPs once per event; we surface the first non-empty note
        // (deterministic over the event order) so a single requirement shows
        // even if it was attached to one of several event RSVPs.
        let dietary = "";
        for (const e of orderedEvents) {
          const rsvp = rsvpByGuest.get(g.guestId)?.get(e.id);
          if (rsvp && rsvp.dietary.trim().length > 0) {
            dietary = rsvp.dietary;
            break;
          }
        }

        rows.push({
          familyCode: g.publicId,
          familyName: g.familyName,
          firstName: g.firstName,
          lastName: g.lastName,
          cells,
          dietary,
        });
      }

      // SORT: alphabetically by family code. `byGuest` preserves the
      // sort_order'd insertion order, and `toSorted` is stable, so members of
      // one family stay together and in their seeded order.
      const sortedRows = rows.toSorted((a, b) =>
        a.familyCode < b.familyCode ? -1 : a.familyCode > b.familyCode ? 1 : 0,
      );

      return {
        events: orderedEvents.map((e) => ({ id: e.id, name: e.name })),
        rows: sortedRows,
      };
    }).pipe(Effect.withSpan("cire.rsvp-export.build"));
  },
};

// ---------------------------------------------------------------------------
// CSV serialisation
// ---------------------------------------------------------------------------

const FORMULA_MARKERS = new Set(["=", "+", "-", "@"]);

/**
 * Defuse CSV formula injection: a cell that (after trimming) starts with one of
 * `= + - @` is interpreted as a formula by Excel / Google Sheets when the file
 * is opened. Unlike the IMPORT side (which REJECTS such cells — they come from
 * an untrusted upload), the EXPORT contains guest-supplied data we still want to
 * surface, so we neutralise it by prefixing a single quote (`'`). The leading
 * whitespace is preserved after the quote so the displayed value is unchanged
 * apart from the guard. Mirrors the same `= + - @` marker set as
 * `cire/api/src/services/spreadsheet.ts`.
 */
export function sanitiseCsvCell(value: string): string {
  const trimmed = value.trimStart();
  if (trimmed.length > 0 && FORMULA_MARKERS.has(trimmed[0]!)) {
    return `'${value}`;
  }
  return value;
}

/** Quote a CSV field iff it contains a comma, quote, or newline (RFC 4180). */
function csvField(value: string): string {
  const safe = sanitiseCsvCell(value);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Fixed leading columns, then one per event, then dietary. */
export function toCsv(data: RsvpExport): string {
  const header = [
    "Family Code",
    "Family Name",
    "Guest First Name",
    "Guest Last Name",
    ...data.events.map((e) => e.name),
    "Dietary Requirements",
  ];

  const lines = [header.map(csvField).join(",")];
  for (const row of data.rows) {
    const fields = [
      row.familyCode,
      row.familyName,
      row.firstName,
      row.lastName,
      ...row.cells.map((c) => CELL_LABEL[c]),
      row.dietary,
    ];
    lines.push(fields.map(csvField).join(","));
  }
  // CRLF line endings (RFC 4180), matching the import templates.
  return lines.join("\r\n");
}
