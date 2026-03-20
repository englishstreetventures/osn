import { Effect, Data } from "effect"
import { eq } from "drizzle-orm"
import { guests, events, guestEvents } from "@cire/db"
import { DbService } from "../db"
import type { ClaimResponse, GuestWithEvents } from "../schemas/claim"

export class InvalidCode extends Data.TaggedError("InvalidCode") {}
export class BadRequest extends Data.TaggedError("BadRequest")<{
  message: string
}> {}

export const claimService = {
  lookup(code: string): Effect.Effect<ClaimResponse, InvalidCode, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService

      const [guest] = db
        .select()
        .from(guests)
        .where(eq(guests.claimCode, code))
        .all()

      if (!guest) return yield* Effect.fail(new InvalidCode())

      const eventRows = db
        .select({
          id: events.id,
          name: events.name,
          date: events.date,
          location: events.location,
          description: events.description,
        })
        .from(guestEvents)
        .innerJoin(events, eq(guestEvents.eventId, events.id))
        .where(eq(guestEvents.guestId, guest.id))
        .all()

      return { guestName: guest.name, events: eventRows }
    })
  },

  getAllGuests(): Effect.Effect<GuestWithEvents[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService

      const allGuests = db.select().from(guests).all()
      const allGuestEvents = db.select().from(guestEvents).all()

      return allGuests.map((guest) => ({
        name: guest.name,
        code: guest.claimCode,
        claimed: false,
        events: allGuestEvents
          .filter((ge) => ge.guestId === guest.id)
          .map((ge) => ge.eventId),
      }))
    })
  },
}
