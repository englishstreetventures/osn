import { Data, Effect } from "effect";
import type { Layer } from "effect";
import { and, eq, inArray } from "drizzle-orm";
import { createGraphService } from "@osn/core";
import { closeFriends, users } from "@osn/db/schema";
import { Db as OsnDb, DbLive as OsnDbLive } from "@osn/db/service";
import { MAX_EVENT_GUESTS } from "../lib/limits";

/**
 * Single error type used by all graph-bridge functions. Wraps any failure
 * from the underlying OSN graph service (`DatabaseError`, `GraphError`,
 * `NotFoundError`) so callers have one tag to catch instead of a union
 * of errors they don't own.
 */
export class GraphBridgeError extends Data.TaggedError("GraphBridgeError")<{
  readonly cause: unknown;
}> {}

/**
 * Isolated bridge to the OSN social graph.
 *
 * This is the only file in `pulse/api` that imports from `@osn/core` or
 * `@osn/db`. Other services call through here so that when S2S migrates
 * from direct package imports to ARC-token HTTP (per TODO.md line 91),
 * the change is local to this file — no touching of `rsvps.ts` or routes.
 *
 * Graph calls require the OSN db layer (`@osn/db/Db`), which is *different*
 * from `@pulse/db/Db`. The two Tags use different identifiers
 * (`@pulse/db/Db` vs `@osn/db/Db`) so they don't collide when both layers
 * are provided to the same Effect.
 */

const graph = createGraphService();

/**
 * The set of user IDs `userId` is connected to (accepted connections only).
 * Returns a `Set` for O(1) membership checks in the RSVP visibility filter.
 *
 * Bounded by `MAX_EVENT_GUESTS` — the platform's hard cap on event guest
 * count (see `lib/limits.ts`). No user on the free tier can have more
 * connections relevant to an event than this limit. Accounts that need
 * larger sets belong to the future verified-organisation tier.
 */
export const getConnectionIds = (
  userId: string,
): Effect.Effect<Set<string>, GraphBridgeError, OsnDb> =>
  graph.listConnections(userId, { limit: MAX_EVENT_GUESTS }).pipe(
    Effect.map((rows) => new Set(rows.map((r) => r.user.id))),
    Effect.mapError((cause) => new GraphBridgeError({ cause })),
  );

/**
 * The set of user IDs `userId` has marked as close friends. Bounded by
 * `MAX_EVENT_GUESTS` for the same reason as `getConnectionIds`.
 */
export const getCloseFriendIds = (
  userId: string,
): Effect.Effect<Set<string>, GraphBridgeError, OsnDb> =>
  graph.listCloseFriends(userId, { limit: MAX_EVENT_GUESTS }).pipe(
    Effect.map((rows) => new Set(rows.map((u) => u.id))),
    Effect.mapError((cause) => new GraphBridgeError({ cause })),
  );

/**
 * Returns the subset of `attendeeIds` that have marked `viewerId` as a
 * close friend — i.e. attendees who explicitly opted to let this viewer
 * into their close-friends-only circle.
 *
 * This is the directionally-correct check for the RSVP visibility
 * filter: when an attendee sets `attendanceVisibility: "close_friends"`,
 * the intent is "only people I consider close friends should see me".
 * The filter must key on the **attendee's** close-friends list, not the
 * viewer's — otherwise a stalker who unilaterally adds a target as a
 * close friend can see the target's gated RSVPs.
 *
 * Implementation: single batched SQL query against `close_friends` with
 * `WHERE friend_id = viewerId AND user_id IN (attendeeIds)`. Avoids N+1
 * regardless of guest count.
 */
export const getCloseFriendsOf = (
  viewerId: string,
  attendeeIds: string[],
): Effect.Effect<Set<string>, GraphBridgeError, OsnDb> =>
  Effect.gen(function* () {
    if (attendeeIds.length === 0) return new Set<string>();
    const { db } = yield* OsnDb;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ userId: closeFriends.userId })
          .from(closeFriends)
          .where(
            and(eq(closeFriends.friendId, viewerId), inArray(closeFriends.userId, attendeeIds)),
          ),
      catch: (cause) => new GraphBridgeError({ cause }),
    });
    return new Set(rows.map((r) => r.userId));
  });

export interface UserDisplay {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * Fetches display metadata for a batch of OSN user IDs. Used by the RSVP
 * service to join names/avatars onto RSVP rows before returning them to
 * the client (names NEVER come from the JWT — always fresh from DB).
 *
 * Returns a Map keyed by user ID for efficient lookup during join.
 */
export const getUserDisplays = (
  userIds: string[],
): Effect.Effect<Map<string, UserDisplay>, GraphBridgeError, OsnDb> =>
  Effect.gen(function* () {
    if (userIds.length === 0) return new Map();
    const { db } = yield* OsnDb;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: users.id,
            handle: users.handle,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(inArray(users.id, userIds)),
      catch: (cause) => new GraphBridgeError({ cause }),
    });
    return new Map(rows.map((r) => [r.id, r]));
  });

/**
 * The OSN DB layer that graph-bridge functions require. Re-exported so
 * callers (routes, services) don't need to import from `@osn/db/service`
 * directly — keeps the `@osn/*` import surface contained.
 */
export const OsnDbLayer: Layer.Layer<OsnDb> = OsnDbLive;
export { OsnDb };
