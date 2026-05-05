import { Effect, Data } from "effect";
import { eq } from "drizzle-orm";
import { rsvps, guests } from "@cire/db";
import { DbService } from "../db";
import type { RsvpRecord } from "../schemas/rsvp";

export class RsvpError extends Data.TaggedError("RsvpError")<{
  message: string;
}> {}

export const rsvpService = {
  submitRsvp(input: {
    guestId: string;
    eventId: string;
    status: "attending" | "declined" | "maybe";
    dietary: string;
    familyId: string;
  }): Effect.Effect<void, RsvpError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // Verify guestId belongs to the claimed family
      const [guest] = db
        .select({ id: guests.id, familyId: guests.familyId })
        .from(guests)
        .where(eq(guests.id, input.guestId))
        .all();

      if (!guest || guest.familyId !== input.familyId) {
        return yield* Effect.fail(
          new RsvpError({ message: "Guest does not belong to this family" }),
        );
      }

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
