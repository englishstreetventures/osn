import { blocks, connections, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, eq, inArray, or } from "drizzle-orm";
import { Data, Effect } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RecommendationError extends Data.TaggedError("RecommendationError")<{
  readonly message: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Caller's connection list is capped before we expand to friends-of-friends.
 * Prevents a hub user with thousands of connections from producing an
 * unbounded FOF fan-out (P-C1). Tuned for the "enough candidates to produce
 * a good top-N list" sweet spot.
 */
const MAX_MY_CONNECTIONS_FOR_FOF = 500;

/**
 * Hard cap on the FOF fan-out row count. Worst-case defence alongside
 * MAX_MY_CONNECTIONS_FOR_FOF — a viral cluster with very dense connections
 * would still be bounded by this limit.
 */
const MAX_FOF_FANOUT_ROWS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Suggestion {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  mutualCount: number;
}

// ---------------------------------------------------------------------------
// Recommendation service factory
// ---------------------------------------------------------------------------

export function createRecommendationService() {
  /**
   * Suggest "people you may know" based on mutual connections (friends-of-friends).
   *
   * Algorithm:
   * 1. Get up to MAX_MY_CONNECTIONS_FOR_FOF accepted connections of the caller.
   * 2. Get all blocked profile IDs (both directions).
   * 3. For each of the caller's connections, find *their* connections (capped).
   * 4. Exclude self, existing connections, and blocked profiles.
   * 5. Count mutual connections per candidate and sort descending.
   * 6. Hydrate top results with profile data.
   */
  const suggestConnections = (
    profileId: string,
    limit = 10,
  ): Effect.Effect<Suggestion[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // Defence-in-depth: the Elysia schema enforces [1, 50], but non-HTTP
      // callers might pass NaN / Infinity / negatives. Coerce any non-finite
      // input back to the default before clamping.
      const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 10, 1), 50);

      // Step 1: Get my accepted connection IDs (capped to bound fan-out).
      const myConnectionRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              requesterId: connections.requesterId,
              addresseeId: connections.addresseeId,
            })
            .from(connections)
            .where(
              and(
                eq(connections.status, "accepted"),
                or(eq(connections.requesterId, profileId), eq(connections.addresseeId, profileId)),
              ),
            )
            .limit(MAX_MY_CONNECTIONS_FOR_FOF),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const myConnectionIds = myConnectionRows.map((r) =>
        r.requesterId === profileId ? r.addresseeId : r.requesterId,
      );

      if (myConnectionIds.length === 0) return [];

      // Step 2: Get blocks (both directions).
      const blockRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              blockerId: blocks.blockerId,
              blockedId: blocks.blockedId,
            })
            .from(blocks)
            .where(or(eq(blocks.blockerId, profileId), eq(blocks.blockedId, profileId))),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const blockedIds = blockRows.map((r) =>
        r.blockerId === profileId ? r.blockedId : r.blockerId,
      );

      // Set for O(1) membership lookup in the aggregation loop (P-W2).
      const myConnectionIdSet = new Set(myConnectionIds);
      const excludeIds = new Set<string>([profileId, ...myConnectionIds, ...blockedIds]);

      // Step 3: For each of my connections, find THEIR accepted connections.
      // Capped fan-out bounds worst-case aggregation cost.
      const fofRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              requesterId: connections.requesterId,
              addresseeId: connections.addresseeId,
            })
            .from(connections)
            .where(
              and(
                eq(connections.status, "accepted"),
                or(
                  inArray(connections.requesterId, myConnectionIds),
                  inArray(connections.addresseeId, myConnectionIds),
                ),
              ),
            )
            .limit(MAX_FOF_FANOUT_ROWS),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // Step 4: Aggregate candidates, counting mutual connections.
      const mutualCounts = new Map<string, number>();

      for (const row of fofRows) {
        const isMutualRequester = myConnectionIdSet.has(row.requesterId);
        const isMutualAddressee = myConnectionIdSet.has(row.addresseeId);

        // Both sides are my connections — edge between two of my friends.
        if (isMutualRequester && isMutualAddressee) continue;

        const candidateId = isMutualRequester ? row.addresseeId : row.requesterId;

        if (excludeIds.has(candidateId)) continue;

        mutualCounts.set(candidateId, (mutualCounts.get(candidateId) ?? 0) + 1);
      }

      if (mutualCounts.size === 0) return [];

      // Step 5: Sort by mutual count descending and take top N.
      const sorted = [...mutualCounts.entries()]
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, safeLimit);

      const candidateIds = sorted.map(([id]) => id);

      // Step 6: Hydrate with profile info.
      const profiles = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: users.id,
              handle: users.handle,
              displayName: users.displayName,
              avatarUrl: users.avatarUrl,
            })
            .from(users)
            .where(inArray(users.id, candidateIds)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const profileMap = new Map(profiles.map((p) => [p.id, p]));

      return sorted
        .map(([id, mutualCount]) => {
          const p = profileMap.get(id);
          if (!p) return null;
          return {
            handle: p.handle,
            displayName: p.displayName,
            avatarUrl: p.avatarUrl,
            mutualCount,
          };
        })
        .filter((s): s is Suggestion => s !== null);
    }).pipe(Effect.withSpan("recommendations.suggest_connections"));

  return { suggestConnections };
}

export type RecommendationService = ReturnType<typeof createRecommendationService>;
