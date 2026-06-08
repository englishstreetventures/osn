import { Effect, Data } from "effect";
import { eq, asc, inArray } from "drizzle-orm";
import { families, guests, events, guestEvents, rsvps } from "@cire/db";
import { DbService } from "../db";
import type { ClaimResponse, OrganiserGuestRow, DressSwatch } from "../schemas/claim";

export class InvalidCredentials extends Data.TaggedError("InvalidCredentials") {}

/**
 * Defence-in-depth: drop any stored URL whose scheme isn't http(s) so a
 * legacy row written before the CSV-import scheme check can't smuggle a
 * `javascript:` href into the organiser UI.
 */
function safeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Decode the JSON-encoded `dress_code_palette` column. Returns `palette: null`
 * + `malformed: true` so the caller can emit a structured log line referencing
 * the offending event id (kept out of this pure helper to preserve testability
 * and avoid threading Effect through every call site).
 */
function decodePalette(raw: string | null): {
  palette: readonly DressSwatch[] | null;
  malformed: boolean;
} {
  if (!raw) return { palette: null, malformed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { palette: null, malformed: true };
  }
  if (!Array.isArray(parsed)) return { palette: null, malformed: true };
  const out: DressSwatch[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).name === "string" &&
      typeof (item as Record<string, unknown>).color === "string"
    ) {
      const t = item as { name: string; color: string };
      out.push({ name: t.name, color: t.color });
    }
  }
  return { palette: out, malformed: false };
}

export const claimService = {
  lookup(publicId: string): Effect.Effect<ClaimResponse, InvalidCredentials, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const [family] = db.select().from(families).where(eq(families.publicId, publicId)).all();
      if (!family) return yield* Effect.fail(new InvalidCredentials());

      // Two queries kept narrow to avoid the cartesian explosion of joining
      // events into the per-guest rows (every event row was previously
      // duplicated once per invited guest, including the JSON palette blob).
      // (a) guests + their event-id memberships, (b) the unique events.
      // Run independently; each shape is small.
      const guestRows = db
        .select({
          guestId: guests.id,
          firstName: guests.firstName,
          lastName: guests.lastName,
          sortOrder: guests.sortOrder,
          eventId: guestEvents.eventId,
        })
        .from(guests)
        .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
        .where(eq(guests.familyId, family.id))
        .orderBy(asc(guests.sortOrder))
        .all();

      const memberMap = new Map<
        string,
        { guestId: string; firstName: string; lastName: string; eventIds: string[] }
      >();
      const eventIds = new Set<string>();
      for (const row of guestRows) {
        let member = memberMap.get(row.guestId);
        if (!member) {
          member = {
            guestId: row.guestId,
            firstName: row.firstName,
            lastName: row.lastName,
            eventIds: [],
          };
          memberMap.set(row.guestId, member);
        }
        if (row.eventId !== null) {
          member.eventIds.push(row.eventId);
          eventIds.add(row.eventId);
        }
      }

      const eventRows =
        eventIds.size === 0
          ? []
          : db
              .select()
              .from(events)
              .where(inArray(events.id, [...eventIds]))
              .all();

      const eventList: ClaimResponse["events"] = [];
      for (const e of eventRows) {
        const { palette, malformed } = decodePalette(e.dressCodePalette);
        if (malformed) {
          yield* Effect.logWarning(`malformed dress_code_palette`, { eventId: e.id });
        }
        eventList.push({
          id: e.id,
          name: e.name,
          date: e.date,
          location: e.location,
          description: e.description,
          startAt: e.startAt,
          endAt: e.endAt,
          timezone: e.timezone,
          address: e.address ?? null,
          dressCodeDescription: e.dressCodeDescription ?? null,
          dressCodePalette: palette,
          pinterestUrl: safeHttpUrl(e.pinterestUrl),
          mapsUrl: safeHttpUrl(e.mapsUrl),
          sortOrder: e.sortOrder ?? 0,
        });
      }
      eventList.sort((a, b) => a.sortOrder - b.sortOrder);

      const rsvpRows = db
        .select({
          guestId: rsvps.guestId,
          eventId: rsvps.eventId,
          status: rsvps.status,
          dietary: rsvps.dietary,
        })
        .from(rsvps)
        .innerJoin(guests, eq(rsvps.guestId, guests.id))
        .where(eq(guests.familyId, family.id))
        .all();

      return {
        familyId: family.id,
        publicId: family.publicId,
        familyName: family.familyName,
        members: Array.from(memberMap.values()),
        events: eventList,
        rsvps: rsvpRows,
      };
    });
  },

  listEvents(): Effect.Effect<
    {
      id: string;
      name: string;
      slug: string;
      sortOrder: number;
      date: string;
      startAt: string;
      endAt: string;
      timezone: string;
      location: string;
      address: string | null;
      description: string;
      dressCodeDescription: string | null;
      dressCodePalette: readonly DressSwatch[] | null;
      pinterestUrl: string | null;
      mapsUrl: string | null;
    }[],
    never,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = db.select().from(events).orderBy(asc(events.sortOrder)).all();
      return rows.map((row) => {
        const { palette } = decodePalette(row.dressCodePalette);
        return {
          id: row.id,
          name: row.name,
          slug: row.slug,
          sortOrder: row.sortOrder,
          date: row.date,
          startAt: row.startAt,
          endAt: row.endAt,
          timezone: row.timezone,
          location: row.location,
          address: row.address,
          description: row.description,
          dressCodeDescription: row.dressCodeDescription,
          dressCodePalette: palette,
          pinterestUrl: safeHttpUrl(row.pinterestUrl),
          mapsUrl: safeHttpUrl(row.mapsUrl),
        };
      });
    });
  },

  getAllGuests(): Effect.Effect<OrganiserGuestRow[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const rows = db
        .select({
          guestId: guests.id,
          firstName: guests.firstName,
          lastName: guests.lastName,
          publicId: families.publicId,
          familyName: families.familyName,
          eventId: guestEvents.eventId,
        })
        .from(guests)
        .innerJoin(families, eq(guests.familyId, families.id))
        .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
        .orderBy(asc(guests.sortOrder))
        .all();

      const byGuest = new Map<string, OrganiserGuestRow>();
      for (const row of rows) {
        let entry = byGuest.get(row.guestId);
        if (!entry) {
          entry = {
            guestId: row.guestId,
            publicId: row.publicId,
            familyName: row.familyName,
            firstName: row.firstName,
            lastName: row.lastName,
            events: [],
          };
          byGuest.set(row.guestId, entry);
        }
        if (row.eventId !== null) entry.events.push(row.eventId);
      }
      return Array.from(byGuest.values());
    });
  },
};
