import { users, connections, blocks } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { commitBatch, jsonEachIn, rowsChanged } from "@shared/db-utils";
import { and, eq, inArray, notExists, or, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { bound } from "../lib/bound";
import { withGraphBlockOp, withGraphConnectionOp } from "../metrics";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// `message` reaches clients verbatim via the routes' `safeError` allowlist
// — construct with static string literals only, never interpolated
// causes or user input. Pinned by tests/lib/safe-error-static-messages.test.ts.
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

/** A connection between `a` and `b`, in either direction. */
const connectionBetween = (a: string, b: string) =>
  or(
    and(eq(connections.requesterId, a), eq(connections.addresseeId, b)),
    and(eq(connections.requesterId, b), eq(connections.addresseeId, a)),
  );

/** A block between `a` and `b`, either way round. */
const blockBetween = (a: string, b: string) =>
  or(
    and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
    and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
  );

/**
 * The connection `row` as it was read: its id, its two profiles and its
 * status. A write that names it changes nothing once another request has
 * accepted, declined or removed it.
 */
const asRead = (row: typeof connections.$inferSelect) =>
  and(
    eq(connections.id, row.id),
    eq(connections.requesterId, row.requesterId),
    eq(connections.addresseeId, row.addresseeId),
    eq(connections.status, row.status),
  );

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
  const eitherBlocked = (
    profileA: string,
    profileB: string,
  ): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(blocks)
            .where(
              or(
                and(eq(blocks.blockerId, profileA), eq(blocks.blockedId, profileB)),
                and(eq(blocks.blockerId, profileB), eq(blocks.blockedId, profileA)),
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

      // The block check and the existing-connection check are
      // independent reads — run them concurrently. Failure priority is
      // preserved by checking `blocked` first below.
      const [blocked, status] = yield* Effect.all(
        [eitherBlocked(requesterId, addresseeId), getConnectionStatus(requesterId, addresseeId)],
        { concurrency: "unbounded" },
      );
      if (blocked) {
        return yield* Effect.fail(new GraphError({ message: "Cannot send connection request" }));
      }
      if (status !== "none") {
        return yield* Effect.fail(new GraphError({ message: "Connection already exists" }));
      }

      // The checks above answer the common case; the insert holds them. It
      // writes only while neither profile blocks the other and no connection
      // stands between them in either direction, so a block or a request that
      // lands after the checks read leaves nothing behind.
      const { db } = yield* Db;
      const ts = now();
      const inserted = yield* Effect.tryPromise({
        try: () =>
          db.insert(connections).select(
            db
              .select({
                id: bound(genId("conn_"), connections.id),
                requesterId: bound(requesterId, connections.requesterId),
                addresseeId: bound(addresseeId, connections.addresseeId),
                status: bound("pending", connections.status),
                createdAt: bound(ts, connections.createdAt),
                updatedAt: bound(ts, connections.updatedAt),
              })
              .from(users)
              .where(
                and(
                  eq(users.id, addresseeId),
                  notExists(
                    db
                      .select({ one: sql`1` })
                      .from(blocks)
                      .where(blockBetween(requesterId, addresseeId)),
                  ),
                  notExists(
                    db
                      .select({ one: sql`1` })
                      .from(connections)
                      .where(connectionBetween(requesterId, addresseeId)),
                  ),
                ),
              ),
          ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rowsChanged(inserted) === 0) {
        // Refused as the checks would refuse now, block first.
        if (yield* eitherBlocked(requesterId, addresseeId)) {
          return yield* Effect.fail(new GraphError({ message: "Cannot send connection request" }));
        }
        return yield* Effect.fail(new GraphError({ message: "Connection already exists" }));
      }
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

      // Accepts the request only while it is still the pending one read: a
      // request declined or cancelled since is not brought back.
      const accepted = yield* Effect.tryPromise({
        try: () =>
          db
            .update(connections)
            .set({ status: "accepted", updatedAt: now() })
            .where(asRead(rows[0])),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rowsChanged(accepted) === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Pending request not found" }));
      }
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

      // Deletes the request only while it is still the pending one read: a
      // request accepted since stays a connection.
      const declined = yield* Effect.tryPromise({
        try: () => db.delete(connections).where(asRead(rows[0])),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rowsChanged(declined) === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Pending request not found" }));
      }
    }).pipe(withGraphConnectionOp("reject"));

  /**
   * Removes an accepted connection or cancels a pending request in either direction.
   */
  const removeConnection = (
    profileId: string,
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
                and(eq(connections.requesterId, profileId), eq(connections.addresseeId, otherId)),
                and(eq(connections.requesterId, otherId), eq(connections.addresseeId, profileId)),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Connection not found" }));
      }

      // Deletes the connection only while it is as read: a pending request
      // accepted since is a connection the caller has not seen, and stays.
      const removed = yield* Effect.tryPromise({
        try: () => db.delete(connections).where(asRead(rows[0])),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rowsChanged(removed) === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Connection not found" }));
      }
    }).pipe(withGraphConnectionOp("remove"));

  const listConnections = (
    profileId: string,
    options: ListOptions = {},
  ): Effect.Effect<
    { profile: typeof users.$inferSelect; connectedAt: Date }[],
    DatabaseError,
    Db
  > =>
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
                or(eq(connections.requesterId, profileId), eq(connections.addresseeId, profileId)),
                eq(connections.status, "accepted"),
              ),
            )
            .limit(limit)
            .offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return [];

      const peerIds = rows.map((r) =>
        r.requesterId === profileId ? r.addresseeId : r.requesterId,
      );
      const updatedAtMap = new Map(
        rows.map((r) => [r.requesterId === profileId ? r.addresseeId : r.requesterId, r.updatedAt]),
      );

      const peers = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(users)
            .where(inArray(users.id, jsonEachIn(peerIds))),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return peers.map((u) => ({ profile: u, connectedAt: updatedAtMap.get(u.id) ?? new Date() }));
    });

  const listPendingRequests = (
    profileId: string,
    options: ListOptions = {},
  ): Effect.Effect<
    { profile: typeof users.$inferSelect; requestedAt: Date }[],
    DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const limit = clampLimit(options.limit);
      const offset = options.offset ?? 0;

      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(connections)
            .where(and(eq(connections.addresseeId, profileId), eq(connections.status, "pending")))
            .limit(limit)
            .offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return [];

      const requesterIds = rows.map((r) => r.requesterId);
      const requestedAtMap = new Map(rows.map((r) => [r.requesterId, r.createdAt]));

      const requesters = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(users)
            .where(inArray(users.id, jsonEachIn(requesterIds))),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return requesters.map((u) => ({
        profile: u,
        requestedAt: requestedAtMap.get(u.id) ?? new Date(),
      }));
    });

  const listOutgoingRequests = (
    profileId: string,
    options: ListOptions = {},
  ): Effect.Effect<
    { profile: typeof users.$inferSelect; requestedAt: Date }[],
    DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const limit = clampLimit(options.limit);
      const offset = options.offset ?? 0;

      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(connections)
            .where(and(eq(connections.requesterId, profileId), eq(connections.status, "pending")))
            .limit(limit)
            .offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return [];

      const addresseeIds = rows.map((r) => r.addresseeId);
      const requestedAtMap = new Map(rows.map((r) => [r.addresseeId, r.createdAt]));

      const addressees = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(users)
            .where(inArray(users.id, jsonEachIn(addresseeIds))),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return addressees.map((u) => ({
        profile: u,
        requestedAt: requestedAtMap.get(u.id) ?? new Date(),
      }));
    });

  // -------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------

  const blockProfile = (
    blockerId: string,
    blockedId: string,
  ): Effect.Effect<void, GraphError | DatabaseError, Db> =>
    Effect.gen(function* () {
      if (blockerId === blockedId) {
        return yield* Effect.fail(new GraphError({ message: "Cannot block yourself" }));
      }

      const { db } = yield* Db;

      // Insert the block, then remove any connection between the two. One
      // batch on D1, one statement at a time on bun:sqlite. Block first: a
      // request sent meanwhile writes only while no block stands, so it lands
      // before the block (and the delete removes it) or is refused after it,
      // whether or not the two statements run apart.
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            db
              .insert(blocks)
              .values({ id: genId("blk_"), blockerId, blockedId, createdAt: now() })
              .onConflictDoNothing(),
            db.delete(connections).where(connectionBetween(blockerId, blockedId)),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withGraphBlockOp("add"));

  const unblockProfile = (
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

      // Answers from the delete, so of two unblocks at once the second is
      // refused as a repeat would be.
      const unblocked = yield* Effect.tryPromise({
        try: () =>
          db
            .delete(blocks)
            .where(
              and(
                eq(blocks.id, rows[0].id),
                eq(blocks.blockerId, blockerId),
                eq(blocks.blockedId, blockedId),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rowsChanged(unblocked) === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Block not found" }));
      }
    }).pipe(withGraphBlockOp("remove"));

  const listBlocks = (
    profileId: string,
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
            .from(blocks)
            .where(eq(blocks.blockerId, profileId))
            .limit(limit)
            .offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return [];

      const blockedIds = rows.map((r) => r.blockedId);

      const blocked = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(users)
            .where(inArray(users.id, jsonEachIn(blockedIds))),
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
    listOutgoingRequests,
    blockProfile,
    unblockProfile,
    listBlocks,
  };
}

export type GraphService = ReturnType<typeof createGraphService>;
