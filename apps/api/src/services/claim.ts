import { Effect, Data } from "effect";
import { eq, asc } from "drizzle-orm";
import { families, guests, events, guestEvents, rsvps } from "@cire/db";
import { DbService } from "../db";
import { verifyPassword, DUMMY_HASH, type HashFailure } from "./family-id";
import type { ClaimResponse, OrganiserGuestRow } from "../schemas/claim";

export class InvalidCredentials extends Data.TaggedError("InvalidCredentials") {}

export const claimService = {
  lookup(
    publicId: string,
    password: string,
  ): Effect.Effect<ClaimResponse, InvalidCredentials | HashFailure, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const [family] = db.select().from(families).where(eq(families.publicId, publicId)).all();

      // Hash even on miss so timing doesn't leak family existence.
      const ok = yield* verifyPassword(password, family?.passwordHash ?? DUMMY_HASH);
      if (!family || !ok) return yield* Effect.fail(new InvalidCredentials());

      // Single join returning one row per (guest × invited event). Guests with
      // no invites still appear via the leftJoin so members stays accurate.
      const rows = db
        .select({
          guestId: guests.id,
          firstName: guests.firstName,
          lastName: guests.lastName,
          sortOrder: guests.sortOrder,
          eventId: events.id,
          eventName: events.name,
          eventDate: events.date,
          eventLocation: events.location,
          eventDescription: events.description,
        })
        .from(guests)
        .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
        .leftJoin(events, eq(guestEvents.eventId, events.id))
        .where(eq(guests.familyId, family.id))
        .orderBy(asc(guests.sortOrder))
        .all();

      const memberMap = new Map<
        string,
        {
          firstName: string;
          lastName: string;
          eventIds: string[];
        }
      >();
      const eventMap = new Map<string, ClaimResponse["events"][number]>();
      for (const row of rows) {
        let member = memberMap.get(row.guestId);
        if (!member) {
          member = {
            firstName: row.firstName,
            lastName: row.lastName,
            eventIds: [],
          };
          memberMap.set(row.guestId, member);
        }
        if (row.eventId !== null) {
          member.eventIds.push(row.eventId);
          if (!eventMap.has(row.eventId)) {
            eventMap.set(row.eventId, {
              id: row.eventId,
              name: row.eventName!,
              date: row.eventDate!,
              location: row.eventLocation!,
              description: row.eventDescription!,
            });
          }
        }
      }

      // Fetch existing RSVPs for this family
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
        publicId: family.publicId,
        familyName: family.familyName,
        members: Array.from(memberMap.values()),
        events: Array.from(eventMap.values()),
        rsvps: rsvpRows,
      };
    });
  },

  getAllGuests(): Effect.Effect<OrganiserGuestRow[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // One query joining families → guests → guestEvents.
      // innerJoin on families ensures orphan guests (FK invariant violations)
      // are skipped at the DB level without an in-memory filter.
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
