import { events } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricEventLocationSaved } from "../metrics";
import type { EventLocationBody } from "../schemas/settings";

/** An event's planning location as the organiser portal reads/writes it.
 *  Location is EVENT-scoped (a wedding can span countries — Sydney reception,
 *  Jaipur ceremonies), so the geocoded point + pricing region live here, not
 *  on the wedding. The free-text venue stays in `events.address`. */
export type EventLocation = {
  eventId: string;
  locationLat: number | null;
  locationLng: number | null;
  pricingRegion: string | null;
};

/** The event doesn't exist or belongs to a different wedding — one 404, so a
 *  member of wedding A can't probe (or write to) wedding B's events. */
export class EventNotInWedding extends Data.TaggedError("EventNotInWedding")<{
  readonly weddingId: string;
  readonly eventId: string;
}> {}

export class EventLocationWriteError extends Data.TaggedError("EventLocationWriteError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export const eventLocationService = {
  /**
   * Set (or clear) an event's location. The body has already passed the schema
   * boundary — ranges checked and the lat/lng pair rule enforced (both set or
   * both null) — so this only re-checks tenancy (the same check-then-write
   * idiom as mark-shared / family-deactivate): the event must belong to
   * :weddingId, and the UPDATE's WHERE carries both ids so a cross-tenant
   * write is impossible even if the row moved between check and write.
   */
  update(
    weddingId: string,
    eventId: string,
    body: EventLocationBody,
  ): Effect.Effect<EventLocation, EventNotInWedding | EventLocationWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const [row] = yield* dbQuery(() =>
        db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)))
          .all(),
      );
      if (!row) {
        return yield* new EventNotInWedding({ weddingId, eventId });
      }

      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .update(events)
              .set({
                locationLat: body.locationLat,
                locationLng: body.locationLng,
                pricingRegion: body.pricingRegion,
              })
              .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)))
              .run(),
          ),
        catch: (cause) => new EventLocationWriteError({ reason: "update", cause }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("event-location write failed", { reason: err.reason }),
        ),
      );

      return {
        eventId,
        locationLat: body.locationLat,
        locationLng: body.locationLng,
        pricingRegion: body.pricingRegion,
      };
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricEventLocationSaved("ok"))),
      Effect.tapErrorTag("EventLocationWriteError", () =>
        Effect.sync(() => metricEventLocationSaved("error")),
      ),
      Effect.withSpan("cire.event_location.update"),
    );
  },
};
