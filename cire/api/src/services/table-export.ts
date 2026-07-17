import { families, guests, events, guestEvents } from "@cire/db";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { serialiseCsv } from "../lib/csv";
import { compareEventsByStart } from "../lib/event-order";
import { decodePalette, safeHttpUrl } from "./claim";

/**
 * Invited-guest count per event for one wedding, aggregated IN SQL (`GROUP BY`
 * returns one row per event instead of one per membership — P-W1) with the
 * same host-family exclusion as every other organiser read. Shared by the
 * events CSV export and the RSVP dashboard view.
 */
export function invitedCountsByEvent(
  weddingId: string,
): Effect.Effect<Map<string, number>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({ eventId: guestEvents.eventId, invited: count() })
        .from(guestEvents)
        .innerJoin(guests, eq(guestEvents.guestId, guests.id))
        .innerJoin(families, eq(guests.familyId, families.id))
        .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
        .groupBy(guestEvents.eventId)
        .all(),
    );
    return new Map(rows.map((r) => [r.eventId, r.invited]));
  });
}

/**
 * Organiser CSV exports for the two dashboard tables — the guest roster and the
 * event list. Companions to `rsvp-export.ts` (which crosses the two): same
 * wedding-scoped reads, same host-family exclusion, same shared serialiser
 * (`lib/csv.ts` — formula-sanitised, RFC 4180, CRLF).
 *
 * Both builders return the finished CSV string; the route wraps it in a
 * `text/csv` attachment response.
 */
export const tableExportService = {
  /**
   * Guest-roster CSV: ONE ROW PER GUEST with their household's code + status
   * columns. weddingId is required — an unscoped variant would be a
   * cross-tenant leak (mirrors `getAllGuests`). Host-kind families (the
   * organiser's own preview family) are excluded. Rows are ordered
   * alphabetically by family code, stable within a family (by guest
   * `sort_order`, then id) — the same ordering as the RSVP export.
   *
   * The `Events` column lists the event NAMES the guest is invited to (in
   * chronological event order); the timestamp columns are ISO-8601 UTC or
   * blank, matching the dashboard's Sent / Opened badges; `Code Status` is
   * `Active` or `Deactivated` (a withdrawn invite).
   */
  guestsCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // The two reads are independently wedding-scoped — collapse them to one
      // D1 round-trip (RT-P-I1; matches the parallel shape in state-export.ts
      // and rsvp-export.ts).
      const [eventRows, guestRows] = yield* Effect.all(
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
          // Guests + family + event memberships (left join → a guest with no
          // invites still appears). Host families excluded.
          dbQuery(() =>
            db
              .select({
                guestId: guests.id,
                firstName: guests.firstName,
                lastName: guests.lastName,
                sortOrder: guests.sortOrder,
                publicId: families.publicId,
                familyName: families.familyName,
                codeSharedAt: families.codeSharedAt,
                firstOpenedAt: families.firstOpenedAt,
                deactivatedAt: families.deactivatedAt,
                eventId: guestEvents.eventId,
              })
              .from(guests)
              .innerJoin(families, eq(guests.familyId, families.id))
              .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
              .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
              .orderBy(asc(guests.sortOrder))
              .all(),
          ),
        ],
        { concurrency: 2 },
      );
      const orderedEvents = eventRows.toSorted(compareEventsByStart);

      interface GuestAcc {
        firstName: string;
        lastName: string;
        publicId: string;
        familyName: string;
        codeSharedAt: Date | null;
        firstOpenedAt: Date | null;
        deactivatedAt: Date | null;
        invited: Set<string>;
      }
      const byGuest = new Map<string, GuestAcc>();
      for (const row of guestRows) {
        let acc = byGuest.get(row.guestId);
        if (!acc) {
          acc = {
            firstName: row.firstName,
            lastName: row.lastName,
            publicId: row.publicId,
            familyName: row.familyName,
            codeSharedAt: row.codeSharedAt,
            firstOpenedAt: row.firstOpenedAt,
            deactivatedAt: row.deactivatedAt,
            invited: new Set<string>(),
          };
          byGuest.set(row.guestId, acc);
        }
        if (row.eventId !== null) acc.invited.add(row.eventId);
      }

      // Stable sort by family code keeps a family's members together and in
      // their seeded sort_order (byGuest preserves insertion order).
      const sorted = Array.from(byGuest.values()).toSorted((a, b) =>
        a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0,
      );

      const header = [
        "Family Code",
        "Family Name",
        "Guest First Name",
        "Guest Last Name",
        "Events",
        "Invite Sent At",
        "Invite Opened At",
        "Code Status",
      ];
      const rows = sorted.map((g) => [
        g.publicId,
        g.familyName,
        g.firstName,
        g.lastName,
        orderedEvents
          .filter((e) => g.invited.has(e.id))
          .map((e) => e.name)
          .join("; "),
        g.codeSharedAt?.toISOString() ?? "",
        g.firstOpenedAt?.toISOString() ?? "",
        g.deactivatedAt === null ? "Active" : "Deactivated",
      ]);

      return serialiseCsv(header, rows);
    }).pipe(Effect.withSpan("cire.table-export.guestsCsv"));
  },

  /**
   * Event-list CSV: one row per event in chronological order (same comparator
   * as the RSVP export's columns), with the details the dashboard shows plus an
   * `Invited Guests` count (host families excluded — the same population the
   * RSVP view counts). URLs pass the same http(s)-only guard as the dashboard;
   * the dress-code palette is rendered as `Name (color)` pairs.
   */
  eventsCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // The two reads are independently wedding-scoped — collapse them to one
      // D1 round-trip (RT-P-I1; matches the parallel shape in state-export.ts
      // and rsvp-export.ts).
      const [eventRows, invitedByEvent] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({
                id: events.id,
                name: events.name,
                slug: events.slug,
                startAt: events.startAt,
                endAt: events.endAt,
                timezone: events.timezone,
                address: events.address,
                description: events.description,
                dressCodeDescription: events.dressCodeDescription,
                dressCodePalette: events.dressCodePalette,
                pinterestUrl: events.pinterestUrl,
                mapsUrl: events.mapsUrl,
                sortOrder: events.sortOrder,
              })
              .from(events)
              .where(eq(events.weddingId, weddingId))
              .all(),
          ),
          invitedCountsByEvent(weddingId),
        ],
        { concurrency: 2 },
      );
      const orderedEvents = eventRows.toSorted(compareEventsByStart);

      const header = [
        "Event Name",
        "Slug",
        "Starts At",
        "Ends At",
        "Timezone",
        "Address",
        "Description",
        "Dress Code",
        "Dress Code Palette",
        "Pinterest URL",
        "Maps URL",
        "Invited Guests",
      ];
      const rows = orderedEvents.map((e) => {
        const { palette } = decodePalette(e.dressCodePalette);
        return [
          e.name,
          e.slug,
          e.startAt,
          e.endAt,
          e.timezone,
          e.address ?? "",
          e.description,
          e.dressCodeDescription ?? "",
          (palette ?? []).map((s) => `${s.name} (${s.color})`).join("; "),
          safeHttpUrl(e.pinterestUrl) ?? "",
          safeHttpUrl(e.mapsUrl) ?? "",
          String(invitedByEvent.get(e.id) ?? 0),
        ];
      });

      return serialiseCsv(header, rows);
    }).pipe(Effect.withSpan("cire.table-export.eventsCsv"));
  },
};
