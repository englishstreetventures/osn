import { families, guests, events, guestEvents, rsvps } from "@cire/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { sanitiseCsvCell, serialiseCsv } from "../lib/csv";
import { compareEventsByStart } from "../lib/event-order";
import { invitedCountsByEvent } from "./table-export";

// Re-exported for existing importers (tests + `download.ts` docs reference this
// module); the implementation moved to `../lib/csv` when the guests/events
// exports were added.
export { sanitiseCsvCell };

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
  /** Writer provenance across this guest's replies (migration 0037):
   *   - "guest"     — every reply was self-submitted.
   *   - "organiser" — at least one reply was organiser-recorded
   *     (`consent_source='organiser_attested'`), so the dietary/consent story is
   *     organiser-attested. Surfaced so a re-report distinguishes phone/paper
   *     RSVPs. "" when the guest has no RSVP at all. */
  recordedBy: "" | "guest" | "organiser";
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

// ---------------------------------------------------------------------------
// In-dashboard read-only RSVP VIEW (JSON, grouped by event)
// ---------------------------------------------------------------------------

/** A guest's response to one event, for the in-dashboard view. `status` is the
 *  raw `rsvps.status` enum (the UI maps it to a label); `dietary` is that
 *  response's dietary note (may be blank). */
export interface RsvpViewGuest {
  guestId: string;
  firstName: string;
  lastName: string;
  familyName: string;
  familyCode: string;
  status: "attending" | "declined" | "maybe";
  dietary: string;
  /** Provenance of this reply (migration 0037): `guest` (self-submitted) vs
   *  `organiser_attested` (an organiser recorded a phone/paper RSVP on the
   *  guest's behalf). The dashboard badges organiser-entered answers so an
   *  overwrite of a guest reply is visible. */
  consentSource: "guest" | "organiser_attested";
}

/** An invited guest with no reply yet — the pool an organiser can record a
 *  phone/paper RSVP FOR (the guest edit control targets these + can overwrite a
 *  responded row). */
export interface RsvpViewInvitedGuest {
  guestId: string;
  firstName: string;
  lastName: string;
  familyName: string;
  familyCode: string;
}

/** One event with its responded guests + a status tally. `invited` is how many
 *  guests are on this event's list; `responded` = attending + declined + maybe.
 *  `noResponse` = invited − responded (never negative). `unresponded` lists the
 *  invited guests without a reply so an editor can record one on their behalf. */
export interface RsvpViewEvent {
  id: string;
  name: string;
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
  guests: RsvpViewGuest[];
  unresponded: RsvpViewInvitedGuest[];
}

export interface RsvpView {
  events: RsvpViewEvent[];
}

export const rsvpExportService = {
  /**
   * Build the read-only in-dashboard RSVP view for one wedding: every event with
   * the guests who responded (status + dietary) and a per-event tally. Reuses the
   * same wedding-scoped, host-excluded data the CSV export reads, just shaped
   * BY EVENT instead of one-row-per-guest. weddingId is required (cross-tenant
   * leak otherwise, mirrors `build`). Events are ordered by start time; guests
   * within an event are ordered by family code then guest sort order.
   */
  buildView(weddingId: string): Effect.Effect<RsvpView, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // All four reads are independently wedding-scoped — collapse them to one
      // D1 round-trip (RT-P-I1; matches the parallel shape in state-export.ts
      // and table-export.ts).
      const [eventRows, invitedByEvent, rsvpRows, invitedRows] = yield* Effect.all(
        [
          dbQuery(() =>
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
          ),
          // Invite counts per event, host families excluded — aggregated in SQL
          // (shared with the events CSV export).
          invitedCountsByEvent(weddingId),
          // RSVP rows joined to guest + family for the per-event guest lists.
          dbQuery(() =>
            db
              .select({
                eventId: rsvps.eventId,
                guestId: rsvps.guestId,
                status: rsvps.status,
                dietary: rsvps.dietary,
                consentSource: rsvps.consentSource,
                firstName: guests.firstName,
                lastName: guests.lastName,
                sortOrder: guests.sortOrder,
                familyName: families.familyName,
                familyCode: families.publicId,
              })
              .from(rsvps)
              .innerJoin(guests, eq(rsvps.guestId, guests.id))
              .innerJoin(families, eq(guests.familyId, families.id))
              .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
              .all(),
          ),
          // Every invitation (guest×event) for the wedding's guests, host families
          // excluded — the pool of guests an organiser can record a reply for. We
          // subtract the responded ids below to get the "not yet replied" list.
          dbQuery(() =>
            db
              .select({
                eventId: guestEvents.eventId,
                guestId: guestEvents.guestId,
                firstName: guests.firstName,
                lastName: guests.lastName,
                sortOrder: guests.sortOrder,
                familyName: families.familyName,
                familyCode: families.publicId,
              })
              .from(guestEvents)
              .innerJoin(guests, eq(guestEvents.guestId, guests.id))
              .innerJoin(families, eq(guests.familyId, families.id))
              .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
              .all(),
          ),
        ],
        { concurrency: 4 },
      );

      const orderedEvents = eventRows.toSorted(compareEventsByStart);

      interface Acc {
        guests: (RsvpViewGuest & { sortOrder: number })[];
        attending: number;
        declined: number;
        maybe: number;
        /** guestIds that have a reply — so `unresponded` excludes them. */
        responded: Set<string>;
      }
      const byEvent = new Map<string, Acc>();
      const accFor = (eventId: string): Acc => {
        let acc = byEvent.get(eventId);
        if (!acc) {
          acc = { guests: [], attending: 0, declined: 0, maybe: 0, responded: new Set() };
          byEvent.set(eventId, acc);
        }
        return acc;
      };
      for (const row of rsvpRows) {
        const acc = accFor(row.eventId);
        acc.responded.add(row.guestId);
        acc.guests.push({
          guestId: row.guestId,
          firstName: row.firstName,
          lastName: row.lastName,
          familyName: row.familyName,
          familyCode: row.familyCode,
          status: row.status,
          dietary: row.dietary,
          consentSource: row.consentSource,
          sortOrder: row.sortOrder,
        });
        if (row.status === "attending") acc.attending += 1;
        else if (row.status === "declined") acc.declined += 1;
        else acc.maybe += 1;
      }

      // Invited-but-unresponded guests, keyed by event (with sort keys so the
      // list orders like the responded one).
      const unrespondedByEvent = new Map<
        string,
        (RsvpViewInvitedGuest & { sortOrder: number })[]
      >();
      for (const row of invitedRows) {
        const acc = accFor(row.eventId);
        if (acc.responded.has(row.guestId)) continue;
        let list = unrespondedByEvent.get(row.eventId);
        if (!list) {
          list = [];
          unrespondedByEvent.set(row.eventId, list);
        }
        list.push({
          guestId: row.guestId,
          firstName: row.firstName,
          lastName: row.lastName,
          familyName: row.familyName,
          familyCode: row.familyCode,
          sortOrder: row.sortOrder,
        });
      }

      const viewEvents: RsvpViewEvent[] = orderedEvents.map((e) => {
        const acc = byEvent.get(e.id);
        const guestList = (acc?.guests ?? [])
          .toSorted((a, b) => {
            if (a.familyCode !== b.familyCode) return a.familyCode < b.familyCode ? -1 : 1;
            if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
            return a.guestId < b.guestId ? -1 : a.guestId > b.guestId ? 1 : 0;
          })
          .map(({ sortOrder: _sortOrder, ...g }) => g);
        const attending = acc?.attending ?? 0;
        const declined = acc?.declined ?? 0;
        const maybe = acc?.maybe ?? 0;
        const responded = attending + declined + maybe;
        const invited = invitedByEvent.get(e.id) ?? 0;
        const unresponded = (unrespondedByEvent.get(e.id) ?? [])
          .toSorted((a, b) => {
            if (a.familyCode !== b.familyCode) return a.familyCode < b.familyCode ? -1 : 1;
            if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
            return a.guestId < b.guestId ? -1 : a.guestId > b.guestId ? 1 : 0;
          })
          .map(({ sortOrder: _sortOrder, ...g }) => g);
        return {
          id: e.id,
          name: e.name,
          invited,
          attending,
          declined,
          maybe,
          responded,
          noResponse: Math.max(0, invited - responded),
          guests: guestList,
          unresponded,
        };
      });

      return { events: viewEvents };
    }).pipe(Effect.withSpan("cire.rsvp-export.buildView"));
  },

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

      // (a), (b), and (c) are all independently wedding-scoped — collapse them
      // to one D1 round-trip (RT-P-I1; matches the parallel shape in
      // state-export.ts and table-export.ts).
      const [eventRows, guestRows, rsvpRows] = yield* Effect.all(
        [
          // (a) Events for the wedding, ordered by start time. `start_at` is an
          // ISO-8601 string with offset, so lexicographic order is NOT reliable
          // across timezones — sort in JS by parsed epoch, falling back to
          // sort_order then id for ties / unparseable timestamps.
          dbQuery(() =>
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
          ),
          // (b) Guests + family + their event memberships (left join → a guest with
          // no invites still appears). Host families excluded.
          dbQuery(() =>
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
          ),
          // (c) RSVPs for the wedding's guests (scoped via the guest→family join so
          // a host family's preview RSVPs, if any, never leak in).
          dbQuery(() =>
            db
              .select({
                guestId: rsvps.guestId,
                eventId: rsvps.eventId,
                status: rsvps.status,
                dietary: rsvps.dietary,
                consentSource: rsvps.consentSource,
              })
              .from(rsvps)
              .innerJoin(guests, eq(rsvps.guestId, guests.id))
              .innerJoin(families, eq(guests.familyId, families.id))
              .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
              .all(),
          ),
        ],
        { concurrency: 3 },
      );

      const orderedEvents = eventRows.toSorted(compareEventsByStart);

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

      // guestId → eventId → {status, dietary, consentSource}
      const rsvpByGuest = new Map<
        string,
        Map<
          string,
          {
            status: "attending" | "declined" | "maybe";
            dietary: string;
            consentSource: "guest" | "organiser_attested";
          }
        >
      >();
      for (const row of rsvpRows) {
        let perGuest = rsvpByGuest.get(row.guestId);
        if (!perGuest) {
          perGuest = new Map();
          rsvpByGuest.set(row.guestId, perGuest);
        }
        perGuest.set(row.eventId, {
          status: row.status,
          dietary: row.dietary,
          consentSource: row.consentSource,
        });
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

        // Writer provenance across the guest's replies: "organiser" if ANY
        // reply was organiser-recorded (so the dietary/consent is attested),
        // "guest" if the guest has replies but all self-submitted, "" if none.
        const perGuest = rsvpByGuest.get(g.guestId);
        let recordedBy: "" | "guest" | "organiser" = "";
        if (perGuest && perGuest.size > 0) {
          recordedBy = "guest";
          for (const rsvp of perGuest.values()) {
            if (rsvp.consentSource === "organiser_attested") {
              recordedBy = "organiser";
              break;
            }
          }
        }

        rows.push({
          familyCode: g.publicId,
          familyName: g.familyName,
          firstName: g.firstName,
          lastName: g.lastName,
          cells,
          dietary,
          recordedBy,
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
// CSV serialisation (shared guard + serialiser live in ../lib/csv)
// ---------------------------------------------------------------------------

/** Human-facing "Recorded By" cell (migration 0037 writer provenance). */
const RECORDED_BY_LABEL: Record<RsvpExportRow["recordedBy"], string> = {
  "": "",
  guest: "Guest",
  organiser: "Organiser",
};

/** Fixed leading columns, then one per event, then dietary, then recorded-by. */
export function toCsv(data: RsvpExport): string {
  const header = [
    "Family Code",
    "Family Name",
    "Guest First Name",
    "Guest Last Name",
    ...data.events.map((e) => e.name),
    "Dietary Requirements",
    "Recorded By",
  ];

  const rows = data.rows.map((row) => [
    row.familyCode,
    row.familyName,
    row.firstName,
    row.lastName,
    ...row.cells.map((c) => CELL_LABEL[c]),
    row.dietary,
    RECORDED_BY_LABEL[row.recordedBy],
  ]);
  return serialiseCsv(header, rows);
}
