import { Elysia, t } from "elysia";
import { Effect, type Layer } from "effect";
import { DbLive, type Db } from "@osn/db/service";
import type { User } from "@osn/db/schema";
import { createAuthService, type AuthConfig } from "../services/auth";
import { createGraphService } from "../services/graph";

// ---------------------------------------------------------------------------
// Rate limiter — per-user fixed window (write operations only)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 60; // requests per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(userId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/** Extracts a safe, non-leaking message from a caught error. */
function safeError(e: unknown): string {
  if (e instanceof Error) {
    // Expose only tagged GraphError / NotFoundError messages; swallow DB internals
    if ("_tag" in e && (e._tag === "GraphError" || e._tag === "NotFoundError")) {
      return (e as { message: string }).message;
    }
  }
  return "Request failed";
}

// TypeBox schema for validated handle params (M4)
const HandleParam = t.Object({
  handle: t.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9_]+$" }),
});

// TypeBox schema for paginated list queries
const PaginationQuery = t.Object({
  limit: t.Optional(t.String()),
  offset: t.Optional(t.String()),
});

// Shared projection for user fields in list responses (L3: displayName typed as nullable)
function userProjection(u: User) {
  return {
    handle: u.handle,
    displayName: u.displayName ?? null,
  };
}

// Parse pagination query params
function parsePagination(query: { limit?: string; offset?: string }) {
  const limit = query.limit !== undefined ? parseInt(query.limit, 10) : undefined;
  const offset = query.offset !== undefined ? parseInt(query.offset, 10) : undefined;
  return {
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
  };
}

export function createGraphRoutes(authConfig: AuthConfig, dbLayer: Layer.Layer<Db> = DbLive) {
  const auth = createAuthService(authConfig);
  const graph = createGraphService();

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(dbLayer)) as Effect.Effect<A, never, never>);

  // Verify token and return caller claims, or set 401
  async function requireAuth(
    authorization: string | undefined,
    set: { status?: number | string },
  ): Promise<{ userId: string; handle: string } | null> {
    const token = extractToken(authorization);
    if (!token) {
      set.status = 401;
      return null;
    }
    try {
      return await Effect.runPromise(Effect.orDie(auth.verifyAccessToken(token)));
    } catch {
      set.status = 401;
      return null;
    }
  }

  // Enforce rate limit; set 429 on breach
  function requireRateLimit(userId: string, set: { status?: number | string }): boolean {
    if (!checkRateLimit(userId)) {
      set.status = 429;
      return false;
    }
    return true;
  }

  // Resolve a handle to a full User row, or set 404
  async function resolveHandle(
    handle: string,
    set: { status?: number | string },
  ): Promise<User | null> {
    try {
      const user = await run(auth.findUserByHandle(handle));
      if (!user) {
        set.status = 404;
        return null;
      }
      return user;
    } catch {
      set.status = 500;
      return null;
    }
  }

  return (
    new Elysia({ prefix: "/graph" })
      // -------------------------------------------------------------------------
      // Connections
      // -------------------------------------------------------------------------
      .post(
        "/connections/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!requireRateLimit(caller.userId, set)) return { error: "Too many requests" };

          const target = await resolveHandle(params.handle, set);
          if (!target) return { error: "User not found" };

          try {
            await run(graph.sendConnectionRequest(caller.userId, target.id));
            set.status = 201;
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        { params: HandleParam },
      )
      .patch(
        "/connections/:handle",
        async ({ params, body, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!requireRateLimit(caller.userId, set)) return { error: "Too many requests" };

          const requester = await resolveHandle(params.handle, set);
          if (!requester) return { error: "User not found" };

          try {
            if (body.action === "accept") {
              await run(graph.acceptConnection(caller.userId, requester.id));
            } else {
              await run(graph.rejectConnection(caller.userId, requester.id));
            }
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          body: t.Object({ action: t.Union([t.Literal("accept"), t.Literal("reject")]) }),
        },
      )
      .delete(
        "/connections/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!requireRateLimit(caller.userId, set)) return { error: "Too many requests" };

          const other = await resolveHandle(params.handle, set);
          if (!other) return { error: "User not found" };

          try {
            await run(graph.removeConnection(caller.userId, other.id));
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        { params: HandleParam },
      )
      .get(
        "/connections",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const list = await run(graph.listConnections(caller.userId, parsePagination(query)));
            return {
              connections: list.map((c) => ({
                ...userProjection(c.user),
                connectedAt: c.connectedAt.toISOString(),
              })),
            };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        { query: PaginationQuery },
      )
      .get(
        "/connections/pending",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const list = await run(
              graph.listPendingRequests(caller.userId, parsePagination(query)),
            );
            return {
              pending: list.map((r) => ({
                ...userProjection(r.user),
                requestedAt: r.requestedAt.toISOString(),
              })),
            };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        { query: PaginationQuery },
      )
      .get(
        "/connections/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const target = await resolveHandle(params.handle, set);
            if (!target) return { error: "User not found" };
            const status = await run(graph.getConnectionStatus(caller.userId, target.id));
            return { status };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        { params: HandleParam },
      )
      // -------------------------------------------------------------------------
      // Close friends
      // -------------------------------------------------------------------------
      .post(
        "/close-friends/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!requireRateLimit(caller.userId, set)) return { error: "Too many requests" };

          const friend = await resolveHandle(params.handle, set);
          if (!friend) return { error: "User not found" };

          try {
            await run(graph.addCloseFriend(caller.userId, friend.id));
            set.status = 201;
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        { params: HandleParam },
      )
      .delete(
        "/close-friends/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!requireRateLimit(caller.userId, set)) return { error: "Too many requests" };

          const friend = await resolveHandle(params.handle, set);
          if (!friend) return { error: "User not found" };

          try {
            await run(graph.removeCloseFriend(caller.userId, friend.id));
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        { params: HandleParam },
      )
      .get(
        "/close-friends",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const list = await run(graph.listCloseFriends(caller.userId, parsePagination(query)));
            return { closeFriends: list.map(userProjection) };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        { query: PaginationQuery },
      )
      // -------------------------------------------------------------------------
      // Blocks
      // -------------------------------------------------------------------------
      .post(
        "/blocks/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!requireRateLimit(caller.userId, set)) return { error: "Too many requests" };

          const blocked = await resolveHandle(params.handle, set);
          if (!blocked) return { error: "User not found" };

          try {
            await run(graph.blockUser(caller.userId, blocked.id));
            set.status = 201;
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        { params: HandleParam },
      )
      .delete(
        "/blocks/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!requireRateLimit(caller.userId, set)) return { error: "Too many requests" };

          const blocked = await resolveHandle(params.handle, set);
          if (!blocked) return { error: "User not found" };

          try {
            await run(graph.unblockUser(caller.userId, blocked.id));
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        { params: HandleParam },
      )
      .get(
        "/blocks",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const list = await run(graph.listBlocks(caller.userId, parsePagination(query)));
            return { blocks: list.map(userProjection) };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        { query: PaginationQuery },
      )
      // -------------------------------------------------------------------------
      // Block status check
      // M1: user-facing endpoint reports only whether *caller* has blocked *target*.
      // The symmetric eitherBlocked check is reserved for ARC token (service-to-service) calls.
      // -------------------------------------------------------------------------
      .get(
        "/is-blocked/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const target = await resolveHandle(params.handle, set);
            if (!target) return { error: "User not found" };
            const blocked = await run(graph.isBlocked(caller.userId, target.id));
            return { blocked };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        { params: HandleParam },
      )
  );
}
