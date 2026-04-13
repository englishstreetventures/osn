import { users } from "@osn/db/schema";
import { Db, DbLive } from "@osn/db/service";
import { inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { requireArc } from "../lib/arc-middleware";
import { createGraphService } from "../services/graph";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIENCE = "osn-core";
const SCOPE_GRAPH_READ = "graph:read";
/** Max profile IDs per batch request — stays well under SQLite's variable limit (999). */
const MAX_BATCH_PROFILE_IDS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extracts a safe, non-leaking message from a caught error. */
function safeError(e: unknown): string {
  if (e instanceof Error) {
    if ("_tag" in e && (e._tag === "GraphError" || e._tag === "NotFoundError")) {
      return (e as { message: string }).message;
    }
  }
  return "Request failed";
}

// ---------------------------------------------------------------------------
// Internal graph routes — ARC token protected
// ---------------------------------------------------------------------------

/**
 * Creates the `/graph/internal/*` route group for service-to-service calls.
 *
 * All routes require `Authorization: ARC <token>` with `graph:read` scope
 * and audience `"osn-core"`. These are read-only endpoints consumed by
 * other OSN services (e.g. Pulse API via the graphBridge).
 *
 * @param dbLayer - Effect Layer providing Db (defaults to DbLive)
 */
export function createInternalGraphRoutes(dbLayer: Layer.Layer<Db> = DbLive) {
  const graph = createGraphService();

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(dbLayer)) as Effect.Effect<A, never, never>);

  return (
    new Elysia({ prefix: "/graph/internal" })
      // -----------------------------------------------------------------------
      // Symmetric block check
      // User-facing endpoint only exposes one-directional isBlocked;
      // eitherBlocked is reserved for S2S callers (see graph.ts comment M1).
      // -----------------------------------------------------------------------
      .get(
        "/either-blocked",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            dbLayer,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          try {
            const blocked = await run(graph.eitherBlocked(query.userA, query.userB));
            return { blocked };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            userA: t.String({ minLength: 1 }),
            userB: t.String({ minLength: 1 }),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Connection status between two users
      // -----------------------------------------------------------------------
      .get(
        "/connection-status",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            dbLayer,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          try {
            const status = await run(graph.getConnectionStatus(query.viewerId, query.targetId));
            return { status };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            viewerId: t.String({ minLength: 1 }),
            targetId: t.String({ minLength: 1 }),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // List connection IDs for a user (returns IDs only for bridge efficiency)
      // -----------------------------------------------------------------------
      .get(
        "/connections",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            dbLayer,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          const limit = query.limit ? parseInt(query.limit, 10) : undefined;

          try {
            const list = await run(
              graph.listConnections(query.profileId, {
                limit: Number.isFinite(limit) ? limit : undefined,
              }),
            );
            return { connectionIds: list.map((c) => c.user.id) };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            profileId: t.String({ minLength: 1 }),
            limit: t.Optional(t.String()),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // List close friend IDs for a user
      // -----------------------------------------------------------------------
      .get(
        "/close-friends",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            dbLayer,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          const limit = query.limit ? parseInt(query.limit, 10) : undefined;

          try {
            const list = await run(
              graph.listCloseFriends(query.profileId, {
                limit: Number.isFinite(limit) ? limit : undefined,
              }),
            );
            return { closeFriendIds: list.map((u) => u.id) };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            profileId: t.String({ minLength: 1 }),
            limit: t.Optional(t.String()),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Single close-friend check
      // -----------------------------------------------------------------------
      .get(
        "/is-close-friend",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            dbLayer,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          try {
            const isCloseFriend = await run(graph.isCloseFriendOf(query.profileId, query.friendId));
            return { isCloseFriend };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            profileId: t.String({ minLength: 1 }),
            friendId: t.String({ minLength: 1 }),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Batched reverse close-friend lookup
      // -----------------------------------------------------------------------
      .post(
        "/close-friends-of",
        async ({ body, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            dbLayer,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          try {
            const result = await run(graph.getCloseFriendsOfBatch(body.viewerId, body.profileIds));
            return { closeFriendIds: [...result] };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          body: t.Object({
            viewerId: t.String({ minLength: 1 }),
            profileIds: t.Array(t.String({ minLength: 1 }), { maxItems: MAX_BATCH_PROFILE_IDS }),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Batch user display metadata
      // -----------------------------------------------------------------------
      .post(
        "/user-displays",
        async ({ body, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            dbLayer,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          try {
            if (body.profileIds.length === 0) return { users: [] };

            const rows = await run(
              Effect.gen(function* () {
                const { db } = yield* Db;
                return yield* Effect.tryPromise({
                  try: () =>
                    db
                      .select({
                        id: users.id,
                        handle: users.handle,
                        displayName: users.displayName,
                        avatarUrl: users.avatarUrl,
                      })
                      .from(users)
                      .where(inArray(users.id, body.profileIds)),
                  catch: (cause) => new Error("DB query failed", { cause }),
                });
              }),
            );

            return { users: rows };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          body: t.Object({
            profileIds: t.Array(t.String({ minLength: 1 }), { maxItems: MAX_BATCH_PROFILE_IDS }),
          }),
        },
      )
  );
}
