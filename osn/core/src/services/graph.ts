import { Data, Effect } from "effect";
import { and, eq, inArray, or } from "drizzle-orm";
import { users, connections, closeFriends, blocks } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { withGraphBlockOp, withGraphCloseFriendOp, withGraphConnectionOp } from "../metrics";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GraphError extends Data.TaggedError("GraphError")<{
  readonly message: string;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListOptions {
  /** Maximum rows to return. Clamped to 1–100. Default: 50. */
  limit?: number;
  /** Zero-based row offset for pagination. Default: 0. */
  offset?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function now(): Date {
  return new Date();
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 100);
}

/** Max items for batched `IN (...)` queries to stay within SQLite variable limits. */
const MAX_BATCH_SIZE = 1000;

// ---------------------------------------------------------------------------
// Graph service factory
// ---------------------------------------------------------------------------

export function createGraphService() {
  // -------------------------------------------------------------------------
  // Block checks
  // -------------------------------------------------------------------------

  const isBlocked = (
    blockerId: string,
    blockedId: string,
  ): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(blocks)
            .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return result.length > 0;
    });

  /**
   * Returns true if either party has blocked the other.
   * Single query via OR — O(1) round-trips regardless of direction.
   */
  const eitherBlocked = (userA: string, userB: string): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(blocks)
            .where(
              or(
                and(eq(blocks.blockerId, userA), eq(blocks.blockedId, userB)),
                and(eq(blocks.blockerId, userB), eq(blocks.blockedId, userA)),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return result.length > 0;
    });

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /**
   * Returns the connection status from the perspective of `viewerId` toward `targetId`.
   * "pending_sent"     — viewer sent a request that is still pending
   * "pending_received" — target sent a request to viewer that is still pending
   * "connected"        — accepted connection exists in either direction
   * "none"             — no relationship
   */
  const getConnectionStatus = (
    viewerId: string,
    targetId: string,
  ): Effect.Effect<"none" | "pending_sent" | "pending_received" | "connected", DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(connections)
            .where(
              or(
                and(eq(connections.requesterId, viewerId), eq(connections.addresseeId, targetId)),
                and(eq(connections.requesterId, targetId), eq(connections.addresseeId, viewerId)),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return "none";

      for (const row of rows) {
        if (row.status === "accepted") return "connected";
        if (row.requesterId === viewerId) return "pending_sent";
        return "pending_received";
      }
      return "none";
    });

  const sendConnectionRequest = (
    requesterId: string,
    addresseeId: string,
  ): Effect.Effect<void, GraphError | DatabaseError, Db> =>
    Effect.gen(function* () {
      if (requesterId === addresseeId) {
        return yield* Effect.fail(new GraphError({ message: "Cannot connect to yourself" }));
      }

      const blocked = yield* eitherBlocked(requesterId, addresseeId);
      if (blocked) {
        return yield* Effect.fail(new GraphError({ message: "Cannot send connection request" }));
      }

      const status = yield* getConnectionStatus(requesterId, addresseeId);
      if (status !== "none") {
        return yield* Effect.fail(new GraphError({ message: "Connection already exists" }));
      }

      const { db } = yield* Db;
      const ts = now();
      yield* Effect.tryPromise({
        try: () =>
          db.insert(connections).values({
            id: genId("conn_"),
            requesterId,
            addresseeId,
            status: "pending",
            createdAt: ts,
            updatedAt: ts,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withGraphConnectionOp("request"));

  const acceptConnection = (
    addresseeId: string,
    requesterId: string,
  ): Effect.Effect<void, GraphError | NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(connections)
            .where(
              and(
                eq(connections.requesterId, requesterId),
                eq(connections.addresseeId, addresseeId),
                eq(connections.status, "pending"),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Pending request not found" }));
      }

      yield* Effect.tryPromise({
        try: () =>
          db
            .update(connections)
            .set({ status: "accepted", updatedAt: now() })
            .where(eq(connections.id, rows[0].id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withGraphConnectionOp("accept"));

  /**
   * Rejects a pending request by deleting the row (keeps schema clean).
   */
  const rejectConnection = (
    addresseeId: string,
    requesterId: string,
  ): Effect.Effect<void, NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(connections)
            .where(
              and(
                eq(connections.requesterId, requesterId),
                eq(connections.addresseeId, addresseeId),
                eq(connections.status, "pending"),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Pending request not found" }));
      }

      yield* Effect.tryPromise({
        try: () => db.delete(connections).where(eq(connections.id, rows[0].id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withGraphConnectionOp("reject"));

  /**
   * Removes an accepted connection or cancels a pending request in either direction.
   */
  const removeConnection = (
    userId: string,
    otherId: string,
  ): Effect.Effect<void, NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(connections)
            .where(
              or(
                and(eq(connections.requesterId, userId), eq(connections.addresseeId, otherId)),
                and(eq(connections.requesterId, otherId), eq(connections.addresseeId, userId)),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Connection not found" }));
      }

      // Atomic: clean up close-friend entries + delete the connection
      const connId = rows[0].id;
      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await tx
              .delete(closeFriends)
              .where(
                or(
                  and(eq(closeFriends.userId, userId), eq(closeFriends.friendId, otherId)),
                  and(eq(closeFriends.userId, otherId), eq(closeFriends.friendId, userId)),
                ),
              );
            await tx.delete(connections).where(eq(connections.id, connId));
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withGraphConnectionOp("remove"));

  const listConnections = (
    userId: string,
    options: ListOptions = {},
  ): Effect.Effect<{ user: typeof users.$inferSelect; connectedAt: Date }[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const limit = clampLimit(options.limit);
      const offset = options.offset ?? 0;

      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(connections)
            .where(
              and(
                or(eq(connections.requesterId, userId), eq(connections.addresseeId, userId)),
                eq(connections.status, "accepted"),
              ),
            )
            .limit(limit)
            .offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return [];

      const peerIds = rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId));
      const updatedAtMap = new Map(
        rows.map((r) => [r.requesterId === userId ? r.addresseeId : r.requesterId, r.updatedAt]),
      );

      const peers = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(inArray(users.id, peerIds)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return peers.map((u) => ({ user: u, connectedAt: updatedAtMap.get(u.id) ?? new Date() }));
    });

  const listPendingRequests = (
    userId: string,
    options: ListOptions = {},
  ): Effect.Effect<{ user: typeof users.$inferSelect; requestedAt: Date }[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const limit = clampLimit(options.limit);
      const offset = options.offset ?? 0;

      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(connections)
            .where(and(eq(connections.addresseeId, userId), eq(connections.status, "pending")))
            .limit(limit)
            .offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return [];

      const requesterIds = rows.map((r) => r.requesterId);
      const requestedAtMap = new Map(rows.map((r) => [r.requesterId, r.createdAt]));

      const requesters = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(inArray(users.id, requesterIds)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return requesters.map((u) => ({
        user: u,
        requestedAt: requestedAtMap.get(u.id) ?? new Date(),
      }));
    });

  // -------------------------------------------------------------------------
  // Close friends
  // -------------------------------------------------------------------------

  const addCloseFriend = (
    userId: string,
    friendId: string,
  ): Effect.Effect<void, GraphError | DatabaseError, Db> =>
    Effect.gen(function* () {
      if (userId === friendId) {
        return yield* Effect.fail(
          new GraphError({ message: "Cannot add yourself as a close friend" }),
        );
      }

      const status = yield* getConnectionStatus(userId, friendId);
      if (status !== "connected") {
        return yield* Effect.fail(
          new GraphError({ message: "Must be connected before adding as a close friend" }),
        );
      }

      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db
            .insert(closeFriends)
            .values({ id: genId("clf_"), userId, friendId, createdAt: now() })
            .onConflictDoNothing(),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withGraphCloseFriendOp("add"));

  const removeCloseFriend = (
    userId: string,
    friendId: string,
  ): Effect.Effect<void, NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(closeFriends)
            .where(and(eq(closeFriends.userId, userId), eq(closeFriends.friendId, friendId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Close friend not found" }));
      }

      yield* Effect.tryPromise({
        try: () => db.delete(closeFriends).where(eq(closeFriends.id, rows[0].id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withGraphCloseFriendOp("remove"));

  const listCloseFriends = (
    userId: string,
    options: ListOptions = {},
  ): Effect.Effect<(typeof users.$inferSelect)[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const limit = clampLimit(options.limit);
      const offset = options.offset ?? 0;

      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(closeFriends)
            .where(eq(closeFriends.userId, userId))
            .limit(limit)
            .offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return [];

      const friendIds = rows.map((r) => r.friendId);

      const friends = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(inArray(users.id, friendIds)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return friends;
    });

  /**
   * Directional check: has `userId` marked `friendId` as a close friend?
   */
  const isCloseFriendOf = (
    userId: string,
    friendId: string,
  ): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ _: closeFriends.id })
            .from(closeFriends)
            .where(and(eq(closeFriends.userId, userId), eq(closeFriends.friendId, friendId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return result.length > 0;
    }).pipe(Effect.withSpan("graph.close_friend.check"));

  /**
   * Batched reverse lookup: which of `userIds` have marked `viewerId` as a
   * close friend? Returns the subset of `userIds` that have done so.
   */
  const getCloseFriendsOfBatch = (
    viewerId: string,
    userIds: string[],
  ): Effect.Effect<Set<string>, DatabaseError, Db> =>
    Effect.gen(function* () {
      if (userIds.length === 0) return new Set<string>();
      const clamped = userIds.length > MAX_BATCH_SIZE ? userIds.slice(0, MAX_BATCH_SIZE) : userIds;
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ userId: closeFriends.userId })
            .from(closeFriends)
            .where(and(eq(closeFriends.friendId, viewerId), inArray(closeFriends.userId, clamped))),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return new Set(rows.map((r) => r.userId));
    }).pipe(Effect.withSpan("graph.close_friend.batch_lookup"));

  // -------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------

  const blockUser = (
    blockerId: string,
    blockedId: string,
  ): Effect.Effect<void, GraphError | DatabaseError, Db> =>
    Effect.gen(function* () {
      if (blockerId === blockedId) {
        return yield* Effect.fail(new GraphError({ message: "Cannot block yourself" }));
      }

      const { db } = yield* Db;

      // Atomic: remove connection + close-friends + insert block
      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await tx
              .delete(connections)
              .where(
                or(
                  and(
                    eq(connections.requesterId, blockerId),
                    eq(connections.addresseeId, blockedId),
                  ),
                  and(
                    eq(connections.requesterId, blockedId),
                    eq(connections.addresseeId, blockerId),
                  ),
                ),
              );
            await tx
              .delete(closeFriends)
              .where(
                or(
                  and(eq(closeFriends.userId, blockerId), eq(closeFriends.friendId, blockedId)),
                  and(eq(closeFriends.userId, blockedId), eq(closeFriends.friendId, blockerId)),
                ),
              );
            await tx
              .insert(blocks)
              .values({ id: genId("blk_"), blockerId, blockedId, createdAt: now() })
              .onConflictDoNothing();
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withGraphBlockOp("add"));

  const unblockUser = (
    blockerId: string,
    blockedId: string,
  ): Effect.Effect<void, NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(blocks)
            .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Block not found" }));
      }

      yield* Effect.tryPromise({
        try: () => db.delete(blocks).where(eq(blocks.id, rows[0].id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withGraphBlockOp("remove"));

  const listBlocks = (
    userId: string,
    options: ListOptions = {},
  ): Effect.Effect<(typeof users.$inferSelect)[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const limit = clampLimit(options.limit);
      const offset = options.offset ?? 0;

      const rows = yield* Effect.tryPromise({
        try: () =>
          db.select().from(blocks).where(eq(blocks.blockerId, userId)).limit(limit).offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return [];

      const blockedIds = rows.map((r) => r.blockedId);

      const blocked = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(inArray(users.id, blockedIds)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return blocked;
    });

  return {
    isBlocked,
    eitherBlocked,
    getConnectionStatus,
    sendConnectionRequest,
    acceptConnection,
    rejectConnection,
    removeConnection,
    listConnections,
    listPendingRequests,
    addCloseFriend,
    removeCloseFriend,
    listCloseFriends,
    isCloseFriendOf,
    getCloseFriendsOfBatch,
    blockUser,
    unblockUser,
    listBlocks,
  };
}

export type GraphService = ReturnType<typeof createGraphService>;
