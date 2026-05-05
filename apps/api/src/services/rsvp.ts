import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { rsvps, guests } from "@cire/db";
import { DbService } from "../db";
import type { RsvpRecord } from "../schemas/rsvp";

export const rsvpService = {
  /**
   * Upsert one RSVP. Caller MUST validate `guestId` belongs to the claimed
   * family before invoking — this method does not re-check ownership. The
   * route handler builds the family-guest set once and validates the whole
   * batch up front, so a per-call SELECT here would be redundant.
   */
  submitRsvp(input: {
    guestId: string;
    eventId: string;
    status: "attending" | "declined" | "maybe";
    dietary: string;
  }): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const now = new Date();
      db.insert(rsvps)
        .values({
          id: crypto.randomUUID(),
          guestId: input.guestId,
          eventId: input.eventId,
          status: input.status,
          dietary: input.dietary,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [rsvps.guestId, rsvps.eventId],
          set: {
            status: input.status,
            dietary: input.dietary,
          },
        })
        .run();
    });
  },

  getRsvpsForFamily(familyId: string): Effect.Effect<RsvpRecord[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const rows = db
        .select({
          guestId: rsvps.guestId,
          eventId: rsvps.eventId,
          status: rsvps.status,
          dietary: rsvps.dietary,
        })
        .from(rsvps)
        .innerJoin(guests, eq(rsvps.guestId, guests.id))
        .where(eq(guests.familyId, familyId))
        .all();

      return rows;
    });
  },
};
