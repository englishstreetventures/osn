import { events, eventRsvps, type Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DatabaseError, EventNotFound } from "./events";

/**
 * Single source of truth for "can this viewer see this event?".
 *
 * The discovery feed (`listEvents`) hides `visibility = "private"`
 * events from non-owners. The same rule MUST be applied at every
 * direct-fetch route — `GET /events/:id`, `/events/:id/ics`,
 * `/events/:id/comms`, `/events/:id/rsvps[/counts]` — otherwise the
 * private affordance is bypassable by anyone who knows or guesses an
 * event ID.
 *
 * The rule:
 *
 *   - Public events    → visible to everyone (incl. unauthenticated).
 *   - Private events   → visible to:
 *                        (a) the organiser
 *                        (b) any user who has an RSVP row for the event
 *                            (going / interested / not_going / invited)
 *                            — i.e. the organiser shared the link with
 *                            them or invited them explicitly.
 *
 * Returns `null` to non-authorised viewers — callers should map that
 * to a 404 (not 403, which would disclose existence).
 */
export const canViewEvent = (
  event: Event,
  viewerId: string | null,
): Effect.Effect<boolean, DatabaseError, Db> =>
  Effect.gen(function* () {
    if (event.visibility === "public") return true;
    if (viewerId == null) return false;
    if (viewerId === event.createdByProfileId) return true;

    // The viewer is authenticated but not the organiser. They're allowed
    // to see the event iff they have an RSVP row (any status — including
    // "invited", which is the organiser's pre-RSVP marker).
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: eventRsvps.id })
          .from(eventRsvps)
          .where(and(eq(eventRsvps.eventId, event.id), eq(eventRsvps.profileId, viewerId)))
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });
    return rows.length > 0;
  });

/**
 * Convenience: load the event AND apply the visibility gate in one
 * Effect. Returns `null` (mapped to 404 by the route layer) when the
 * event doesn't exist OR the viewer can't see it.
 *
 * Note: returning `null` for both "not found" and "not visible" is
 * deliberate — distinguishing the two would let an attacker probe the
 * existence of private events by checking response shape.
 */
export const loadVisibleEvent = (
  eventId: string,
  viewerId: string | null,
): Effect.Effect<Event | null, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db.select().from(events).where(eq(events.id, eventId)).limit(1) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) return null;
    const event = rows[0]!;
    const visible = yield* canViewEvent(event, viewerId);
    return visible ? event : null;
  }).pipe(Effect.withSpan("events.load_visible"));

/**
 * Re-export for tests + routes that don't need the full event row.
 */
export type { EventNotFound };
