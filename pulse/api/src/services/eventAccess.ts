import { events, eventRsvps, type Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DatabaseError, EventNotFound } from "./events";

export { buildVisibilityFilter } from "./eventVisibility";

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
 *                            (going / maybe / not_going / invited)
 *                            — i.e. the organiser shared the link with
 *                            them or invited them explicitly.
 *
 * Returns `null` to non-authorised viewers — callers should map that
 * to a 404 (not 403, which would disclose existence).
 */
export const canViewEvent = (
  // Only the visibility/ownership/identity columns are consulted, so the
  // caller can pass a trimmed projection (see `checkEventVisibility`)
  // rather than a full event row.
  event: Pick<Event, "id" | "visibility" | "createdByProfileId">,
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
 * Lightweight visibility gate for the metric-only share / exposure
 * endpoints. Returns the event's `createdByProfileId` when the viewer
 * may see it (so the caller can apply the organiser self-view
 * exclusion), or `null` (→ 404) when the event is missing or hidden.
 *
 * Unlike `loadVisibleEvent` this selects only the three columns the gate
 * consults instead of the full event row — the share / exposure pings
 * are high-frequency (120 / 60 per-IP per minute) and never need the
 * event body, so we keep the per-ping read as cheap as possible. Public
 * events short-circuit before the `event_rsvps` lookup via `canViewEvent`.
 */
export const checkEventVisibility = (
  eventId: string,
  viewerId: string | null,
): Effect.Effect<{ createdByProfileId: string } | null, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: events.id,
            visibility: events.visibility,
            createdByProfileId: events.createdByProfileId,
          })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) return null;
    const meta = rows[0]!;
    const visible = yield* canViewEvent(meta, viewerId);
    return visible ? { createdByProfileId: meta.createdByProfileId } : null;
  }).pipe(Effect.withSpan("events.check_visibility"));

/**
 * Policy (W4 / P5): may this viewer see the *attendee identities* (the
 * per-guest profile rows) for the event, as opposed to merely seeing that
 * the event exists?
 *
 * Visibility (`canViewEvent`) and attendee-identity disclosure are distinct
 * concerns: an invited guest can open a private event but the organiser may
 * not want the full guest list exposed to every attendee. Today this policy
 * is **organiser-only** — the event creator is the one party guaranteed to
 * be allowed to enumerate guests. It is surfaced as an additive,
 * non-breaking `canViewAttendees` flag on the attendee response so existing
 * clients keep working while the UI migrates; the eventual organiser-only
 * *cutover* of the row payload itself is deferred (see
 * `[[wiki/systems/event-access]]`).
 *
 * Pure + synchronous: it only inspects ownership, so it needs no DB round
 * trip and can be called inline in the route handler. Accepts a trimmed
 * projection so a caller with only `{ createdByProfileId }` can use it.
 */
export const canViewAttendees = (
  event: Pick<Event, "createdByProfileId">,
  viewerId: string | null,
): boolean => viewerId != null && viewerId === event.createdByProfileId;

/**
 * Re-export for tests + routes that don't need the full event row.
 */
export type { EventNotFound };
