import { Data, Effect, Schema } from "effect";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { events, eventRsvps, type Event, type EventRsvp } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { MAX_EVENT_GUESTS } from "../lib/limits";
import { metricRsvpInviteBatch, metricRsvpListed, metricRsvpUpserted } from "../metrics";
import { EventNotFound, DatabaseError, ValidationError } from "./events";
import { ensurePulseUser, getAttendanceVisibilityBatch } from "./pulseUsers";
import {
  getCloseFriendsOf,
  getConnectionIds,
  getUserDisplays,
  GraphBridgeError,
  OsnDb,
  type UserDisplay,
} from "./graphBridge";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RsvpNotFound extends Data.TaggedError("RsvpNotFound")<{
  readonly eventId: string;
  readonly userId: string;
}> {}

export class NotInvited extends Data.TaggedError("NotInvited")<{
  readonly eventId: string;
  readonly userId: string;
}> {}

export class GuestListHidden extends Data.TaggedError("GuestListHidden")<{
  readonly eventId: string;
}> {}

export class NotEventOwner extends Data.TaggedError("NotEventOwner")<{
  readonly eventId: string;
}> {}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Wire-level statuses accepted from clients. "invited" is reserved for the
 * organiser invite flow and is rejected on upsertRsvp.
 */
const UserRsvpStatusSchema = Schema.Literal("going", "interested", "not_going");
export type UserRsvpStatus = Schema.Schema.Type<typeof UserRsvpStatusSchema>;

const UpsertRsvpSchema = Schema.Struct({
  status: UserRsvpStatusSchema,
});

const InviteGuestsSchema = Schema.Struct({
  // Bulk-invite batch is capped at the same MAX_EVENT_GUESTS platform
  // limit — an organiser can't invite more people than the event itself
  // can hold. See `lib/limits.ts` for the rationale.
  userIds: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_EVENT_GUESTS),
  ),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RsvpWithUser extends EventRsvp {
  user: UserDisplay | null;
  /**
   * True when this attendee has marked the current viewer as a close
   * friend. Computed server-side against the OSN graph so the client
   * can't derive it by other means. Drives the green-outline avatar
   * affordance on the event-detail page.
   *
   * Always false for unauthenticated viewers.
   */
  isCloseFriend: boolean;
}

export interface RsvpCounts {
  going: number;
  interested: number;
  not_going: number;
  invited: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const genRsvpId = () => "rsvp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

const loadEvent = (eventId: string): Effect.Effect<Event, EventNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db.select().from(events).where(eq(events.id, eventId)).limit(1) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) {
      return yield* Effect.fail(new EventNotFound({ id: eventId }));
    }
    return rows[0]!;
  });

const loadRsvp = (
  eventId: string,
  userId: string,
): Effect.Effect<EventRsvp | null, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<EventRsvp[]> =>
        db
          .select()
          .from(eventRsvps)
          .where(and(eq(eventRsvps.eventId, eventId), eq(eventRsvps.userId, userId)))
          .limit(1) as Promise<EventRsvp[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    return rows[0] ?? null;
  });

// ---------------------------------------------------------------------------
// Visibility filtering
// ---------------------------------------------------------------------------

/**
 * Decides whether `viewerId` is allowed to see ANY rows for `event` —
 * the coarse access check that runs before per-row attendee-privacy
 * filtering.
 *
 * - organiser          → sees everything
 * - public guest list  → everyone sees (even unauthenticated)
 * - connections        → only the organiser's connections see
 * - private guest list → only the organiser
 *
 * Per-row filtering (each attendee's own `attendanceVisibility`) is
 * applied unconditionally afterwards in `filterByAttendeePrivacy`,
 * which handles its own organiser bypass.
 */
const computeCanSeeAnyRsvps = (
  event: Event,
  viewerId: string | null,
): Effect.Effect<boolean, DatabaseError | GraphBridgeError, Db | OsnDb> =>
  Effect.gen(function* () {
    if (viewerId && viewerId === event.createdByUserId) return true;
    switch (event.guestListVisibility) {
      case "public":
        return true;
      case "connections": {
        if (!viewerId) return false;
        const connectionSet = yield* getConnectionIds(event.createdByUserId);
        return connectionSet.has(viewerId);
      }
      case "private":
        return false;
    }
  });

/**
 * Per-row privacy filter applied after the coarse guest-list check passes.
 *
 * Each attendee's own attendanceVisibility setting determines whether
 * their RSVP can be exposed to a specific viewer:
 * - "connections"   → only attendees connected to the viewer see the row
 * - "close_friends" → only attendees who have marked the viewer as a
 *                     close friend (attendee-side directional check —
 *                     the attendee owns the privacy decision)
 * - "no_one"        → hidden from everyone
 *
 * PUBLIC-GUEST-LIST OVERRIDE: if the event's guest list is public, the
 * attendee has implicitly opted in by RSVPing — their per-row setting is
 * ignored for that event. This matches the feature spec.
 *
 * The viewer themselves always sees their own RSVP.
 * The organiser always sees all RSVPs (handled in computeGuestListAccess).
 *
 * This function ALSO stamps `isCloseFriend` on every returned row so the
 * client can render a close-friend affordance (e.g. a coloured outline
 * on the avatar). The flag is computed from the attendee's close-friends
 * list relative to the viewer — same directional semantic as the filter.
 */
const filterByAttendeePrivacy = (
  event: Event,
  rows: RsvpWithUser[],
  viewerId: string | null,
): Effect.Effect<RsvpWithUser[], DatabaseError | GraphBridgeError, Db | OsnDb> =>
  Effect.gen(function* () {
    const attendeeIds = Array.from(new Set(rows.map((r) => r.userId)));

    // `closeFriendsOfViewer` is the set of attendee ids who have marked
    // the viewer as a close friend. Used for the per-row filter AND for
    // the `isCloseFriend` flag on returned rows.
    const closeFriendsOfViewer = viewerId
      ? yield* getCloseFriendsOf(viewerId, attendeeIds)
      : new Set<string>();

    const stampCloseFriend = (row: RsvpWithUser): RsvpWithUser => ({
      ...row,
      isCloseFriend: closeFriendsOfViewer.has(row.userId),
    });

    // Organiser bypass: the event organiser sees every row regardless
    // of guest-list visibility or per-attendee privacy settings. We
    // still stamp the close-friend flag so the organiser's UI can
    // surface the same affordance.
    if (viewerId && viewerId === event.createdByUserId) {
      return rows.map(stampCloseFriend);
    }

    // Public guest list: by attending, attendees implicitly opted into
    // being listed; per-row attendee-privacy is bypassed.
    if (event.guestListVisibility === "public") {
      return rows.map(stampCloseFriend);
    }

    // Batch-fetch attendance visibility for every attendee in one query.
    const visibilityMap = yield* getAttendanceVisibilityBatch(attendeeIds);

    // For "connections" we need the viewer's connection set.
    const viewerConnections = viewerId ? yield* getConnectionIds(viewerId) : new Set<string>();

    return rows
      .filter((row) => {
        // Always allow the viewer to see their own RSVP.
        if (viewerId && row.userId === viewerId) return true;

        const visibility = visibilityMap.get(row.userId) ?? "connections";
        switch (visibility) {
          case "no_one":
            return false;
          case "connections":
            return viewerId != null && viewerConnections.has(row.userId);
          case "close_friends":
            // Attendee-side directional check: the attendee must have
            // added the viewer to their close-friends list. A viewer
            // who unilaterally marks someone as a close friend does
            // NOT gain visibility into that person's gated RSVPs.
            return closeFriendsOfViewer.has(row.userId);
        }
      })
      .map(stampCloseFriend);
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create or update an RSVP for the caller on a given event.
 *
 * Enforces:
 *   - event must exist
 *   - "invited" status is never accepted from end users (organiser-only,
 *     via inviteGuests)
 *   - joinPolicy === "guest_list" → the caller must already have an
 *     "invited" row; otherwise NotInvited
 *   - event.allowInterested === false → rejects status === "interested"
 *
 * Also lazily ensures a pulse_users row exists for the caller.
 */
export const upsertRsvp = (
  eventId: string,
  userId: string,
  data: unknown,
): Effect.Effect<EventRsvp, EventNotFound | ValidationError | NotInvited | DatabaseError, Db> =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknown(UpsertRsvpSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const event = yield* loadEvent(eventId);

    if (validated.status === "interested" && !event.allowInterested) {
      return yield* Effect.fail(
        new ValidationError({ cause: "This event does not accept 'Maybe' RSVPs" }),
      );
    }

    const existing = yield* loadRsvp(eventId, userId);

    // Guest-list events require a prior invite row for the user.
    if (event.joinPolicy === "guest_list" && event.createdByUserId !== userId) {
      if (existing === null) {
        return yield* Effect.fail(new NotInvited({ eventId, userId }));
      }
      // existing row must be an invite or a prior RSVP; either way the
      // user is allowed to update their status.
    }

    const { db } = yield* Db;
    const now = new Date();

    if (existing === null) {
      // Only lazy-create the pulse_users row on first RSVP insert. On
      // update the row must already exist, so skip the extra round-trip.
      yield* ensurePulseUser(userId);
      const id = genRsvpId();
      yield* Effect.tryPromise({
        try: () =>
          db.insert(eventRsvps).values({
            id,
            eventId,
            userId,
            status: validated.status,
            createdAt: now,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricRsvpUpserted(validated.status, true, "ok");
      return {
        id,
        eventId,
        userId,
        status: validated.status,
        invitedByUserId: null,
        createdAt: now,
      };
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(eventRsvps)
          .set({ status: validated.status })
          .where(eq(eventRsvps.id, existing.id)),
      catch: (cause) => new DatabaseError({ cause }),
    });
    metricRsvpUpserted(validated.status, false, "ok");
    return { ...existing, status: validated.status };
  }).pipe(Effect.withSpan("rsvps.upsert"));

/**
 * Organiser-only: bulk-invite users to a guest-list event. Creates rows
 * with status = "invited" for users that don't already have an RSVP.
 * Existing rows are left untouched (so accepted invites stay accepted).
 */
export const inviteGuests = (
  eventId: string,
  organiserId: string,
  data: unknown,
): Effect.Effect<
  { invited: number },
  EventNotFound | NotEventOwner | ValidationError | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknown(InviteGuestsSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const event = yield* loadEvent(eventId);
    if (event.createdByUserId !== organiserId) {
      return yield* Effect.fail(new NotEventOwner({ eventId }));
    }

    const { db } = yield* Db;

    // Find which users already have a row for this event (any status).
    const existing = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ userId: eventRsvps.userId })
          .from(eventRsvps)
          .where(
            and(
              eq(eventRsvps.eventId, eventId),
              inArray(eventRsvps.userId, [...validated.userIds]),
            ),
          ),
      catch: (cause) => new DatabaseError({ cause }),
    });
    const existingIds = new Set(existing.map((r) => r.userId));
    const toInvite = validated.userIds.filter((id) => !existingIds.has(id));
    if (toInvite.length === 0) {
      metricRsvpInviteBatch(0, "ok");
      return { invited: 0 };
    }

    const now = new Date();
    const rows = toInvite.map((uid) => ({
      id: genRsvpId(),
      eventId,
      userId: uid,
      status: "invited" as const,
      invitedByUserId: organiserId,
      createdAt: now,
    }));
    yield* Effect.tryPromise({
      try: () => db.insert(eventRsvps).values(rows),
      catch: (cause) => new DatabaseError({ cause }),
    });
    metricRsvpInviteBatch(rows.length, "ok");
    return { invited: rows.length };
  }).pipe(Effect.withSpan("rsvps.invite_guests"));

/**
 * Returns RSVPs for an event, joined with user display metadata, after
 * applying visibility filtering. Returns an empty array when the viewer
 * has no access (not an error — the caller decides how to present it).
 *
 * **Invited-status is organiser-only.** Queries with `status: "invited"`
 * are rejected unless the viewer is the event organiser, because an
 * invite list is the organiser's address book for the event and the
 * invitees never opted to be shown (unlike attendees who chose "going").
 */
export const listRsvps = (
  eventId: string,
  viewerId: string | null,
  options: {
    status?: EventRsvp["status"];
    limit?: number;
  } = {},
): Effect.Effect<RsvpWithUser[], EventNotFound | DatabaseError | GraphBridgeError, Db | OsnDb> =>
  Effect.gen(function* () {
    const event = yield* loadEvent(eventId);

    // S-H4: invite lists are organiser-only. Return empty rather than
    // an error so the route can render the same 200-empty response as
    // any other "no visible rows" state — the existence of the event
    // is already gated upstream by the route's canViewEvent check.
    if (options.status === "invited" && viewerId !== event.createdByUserId) {
      metricRsvpListed("invited", 0);
      return [];
    }

    const canSee = yield* computeCanSeeAnyRsvps(event, viewerId);
    if (!canSee) {
      metricRsvpListed(options.status ?? "all", 0);
      return [];
    }

    const { db } = yield* Db;
    const limit = Math.min(Math.max(1, options.limit ?? 50), 200);

    const filters = [eq(eventRsvps.eventId, eventId)];
    if (options.status) filters.push(eq(eventRsvps.status, options.status));

    const rsvpRows = yield* Effect.tryPromise({
      try: (): Promise<EventRsvp[]> =>
        db
          .select()
          .from(eventRsvps)
          .where(and(...filters))
          .orderBy(desc(eventRsvps.createdAt))
          .limit(limit) as Promise<EventRsvp[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Join with user displays from osn/db. `isCloseFriend` is set to
    // false here and then (potentially) overridden by the per-row
    // filter below. This way rows always carry the flag, even when the
    // per-row filter is skipped.
    const userIds = Array.from(new Set(rsvpRows.map((r) => r.userId)));
    const userMap = yield* getUserDisplays(userIds);
    const joined: RsvpWithUser[] = rsvpRows.map((row) => ({
      ...row,
      user: userMap.get(row.userId) ?? null,
      isCloseFriend: false,
    }));

    // Even when per-row filtering isn't required (organiser view), we
    // still want to stamp the close-friend flag — the organiser sees
    // the list and benefits from the same affordance.
    const filtered = yield* filterByAttendeePrivacy(event, joined, viewerId);
    metricRsvpListed(options.status ?? "all", filtered.length);
    return filtered;
  }).pipe(Effect.withSpan("rsvps.list"));

/**
 * Returns the latest N RSVPs (default 5) for the inline "who's going" strip
 * on the event detail page. Shorthand over listRsvps with status=going.
 */
export const latestRsvps = (
  eventId: string,
  viewerId: string | null,
  limit = 5,
): Effect.Effect<RsvpWithUser[], EventNotFound | DatabaseError | GraphBridgeError, Db | OsnDb> =>
  listRsvps(eventId, viewerId, { status: "going", limit });

/**
 * Returns the counts per status. Counts are always visible (they don't
 * leak identity). Does not apply the attendee-privacy filter — that's for
 * detail rows, not aggregates.
 */
export const rsvpCounts = (
  eventId: string,
): Effect.Effect<RsvpCounts, EventNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    yield* loadEvent(eventId); // 404 if missing
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<{ status: EventRsvp["status"]; total: number }[]> =>
        db
          .select({ status: eventRsvps.status, total: count() })
          .from(eventRsvps)
          .where(eq(eventRsvps.eventId, eventId))
          .groupBy(eventRsvps.status) as Promise<{ status: EventRsvp["status"]; total: number }[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    const counts: RsvpCounts = { going: 0, interested: 0, not_going: 0, invited: 0 };
    for (const row of rows) counts[row.status] = Number(row.total);
    return counts;
  });
