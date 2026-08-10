import type { Profile } from "@osn/db/schema";
import { DbLive, type Db } from "@osn/db/service";
import { createRateLimiter, type RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { makeSafeError } from "../lib/safe-error";
import { createAuthService, type AuthConfig } from "../services/auth";
import { createGraphService } from "../services/graph";
import {
  graphConnectionStatus,
  graphConnectionSummary,
  graphErrorResponse,
  graphOkResponse,
  graphProfileSummary,
  graphRequestSummary,
} from "./response-schemas";

// ---------------------------------------------------------------------------
// Rate limiter — per-user fixed window (write operations only)
//
// Uses the shared `createRateLimiter` from lib/rate-limit so Phase 2 of the
// Redis migration (TODO.md) swaps graph and auth rate limiters via the same
// backend abstraction. Previous inline `rateLimitStore` + `checkRateLimit`
// duplicated the logic AND never evicted expired entries (P-W1 / S-L18);
// the shared limiter handles sweeping + maxEntries for us.
// ---------------------------------------------------------------------------

const GRAPH_RATE_LIMIT_MAX = 60; // requests per window
const GRAPH_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

/** Default in-memory graph rate limiter. Override via `createGraphRoutes` for Redis. */
export function createDefaultGraphRateLimiter(): RateLimiterBackend {
  return createRateLimiter({
    maxRequests: GRAPH_RATE_LIMIT_MAX,
    windowMs: GRAPH_RATE_LIMIT_WINDOW_MS,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// Expose only tagged GraphError / NotFoundError messages; swallow DB internals.
// FiberFailure-aware — see `makeSafeError` for why a plain `_tag` check fails.
const safeError = makeSafeError(["GraphError", "NotFoundError"]);

// TypeBox schema for validated handle params (M4)
const HandleParam = t.Object({
  handle: t.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9_]+$" }),
});

// TypeBox schema for paginated list queries
const PaginationQuery = t.Object({
  limit: t.Optional(t.String()),
  offset: t.Optional(t.String()),
});

// Shared projection for profile fields in list responses (L3: displayName typed as nullable)
function profileProjection(u: Profile) {
  return {
    id: u.id,
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

export function createGraphRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db> = DbLive,
  /** See `createAuthRoutes` — same semantics. */
  loggerLayer: Layer.Layer<never> = Layer.empty,
  /**
   * Rate limiter backend for graph write operations (connections / blocks
   * mutations, keyed by user ID). Default is a fresh in-memory limiter;
   * supply a Redis-backed `RateLimiterBackend` here to share state across
   * processes (Phase 2 of the Redis migration plan).
   */
  rateLimiter: RateLimiterBackend = createDefaultGraphRateLimiter(),
  /** Shared application runtime (see `createAuthRoutes`). */
  runtime?: AppRuntime,
) {
  // Fail-fast: validate the injected rate limiter at construction time (S-L2).
  if (typeof rateLimiter?.check !== "function") {
    throw new Error("Graph rateLimiter must have a check() method");
  }

  const auth = createAuthService(authConfig);
  const graph = createGraphService();

  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));

  // Verify token and return caller claims, or set 401
  async function requireAuth(
    authorization: string | undefined,
    set: { status?: number | string },
  ): Promise<{ profileId: string; handle: string } | null> {
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

  // Enforce rate limit; set 429 on breach. Async to accommodate future
  // Redis backend where `check()` returns a Promise.
  // Fail-closed (S-M1): if the backend rejects, treat as rate-limited.
  async function requireRateLimit(
    profileId: string,
    set: { status?: number | string },
  ): Promise<boolean> {
    let allowed: boolean;
    try {
      allowed = await rateLimiter.check(profileId);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      set.status = 429;
      return false;
    }
    return true;
  }

  // Resolve a handle to a full profile row, or set 404
  async function resolveHandle(
    handle: string,
    set: { status?: number | string },
  ): Promise<Profile | null> {
    try {
      const profile = await run(auth.findProfileByHandle(handle));
      if (!profile) {
        set.status = 404;
        return null;
      }
      return profile;
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
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          const target = await resolveHandle(params.handle, set);
          if (!target) return { error: "Profile not found" };

          try {
            await run(graph.sendConnectionRequest(caller.profileId, target.id));
            set.status = 201;
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          response: {
            // 201 rather than 200: a request row now exists, and the sender
            // sees it in `/connections/sent`.
            201: graphOkResponse,
            // Every refusal the service raises — already connected, request
            // already pending, blocked in either direction, self-connect —
            // arrives here through `safeError`, which keeps a tagged
            // `GraphError` message and swallows anything else.
            400: graphErrorResponse,
            401: graphErrorResponse,
            // No profile with that handle. Note the block cases do NOT land
            // here: a blocked target still resolves, and the refusal is a 400.
            404: graphErrorResponse,
            429: graphErrorResponse,
            // Only from `resolveHandle`'s catch — the mutation's own failures
            // are already 400s.
            500: graphErrorResponse,
          },
          detail: { operationId: "sendConnectionRequest", security: [{ bearerAuth: [] }] },
        },
      )
      .patch(
        "/connections/:handle",
        async ({ params, body, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          const requester = await resolveHandle(params.handle, set);
          if (!requester) return { error: "Profile not found" };

          try {
            if (body.action === "accept") {
              await run(graph.acceptConnection(caller.profileId, requester.id));
            } else {
              await run(graph.rejectConnection(caller.profileId, requester.id));
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
          response: {
            // Accept and reject both answer `{ ok: true }` — the caller
            // already knows which it asked for, and neither leaves anything
            // to report.
            200: graphOkResponse,
            // Includes "there was no pending request from that profile",
            // which is what a double-accept looks like.
            400: graphErrorResponse,
            401: graphErrorResponse,
            404: graphErrorResponse,
            429: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "respondToConnectionRequest", security: [{ bearerAuth: [] }] },
        },
      )
      .delete(
        "/connections/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          const other = await resolveHandle(params.handle, set);
          if (!other) return { error: "Profile not found" };

          try {
            await run(graph.removeConnection(caller.profileId, other.id));
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          response: {
            // Removal is symmetric — it deletes the edge, not the caller's
            // half of it, so the other profile loses the connection too.
            200: graphOkResponse,
            // "Not connected" is a 400, not a 404: the profile exists, the
            // edge doesn't.
            400: graphErrorResponse,
            401: graphErrorResponse,
            404: graphErrorResponse,
            429: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "removeConnection", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/connections",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const list = await run(graph.listConnections(caller.profileId, parsePagination(query)));
            return {
              connections: list.map((c) =>
                Object.assign({}, profileProjection(c.profile), {
                  connectedAt: c.connectedAt.toISOString(),
                }),
              ),
            };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: PaginationQuery,
          response: {
            200: t.Object({ connections: t.Array(graphConnectionSummary) }),
            // Reads aren't rate limited and take no handle, so this route
            // cannot 404 or 429 — the only two failures are "no token" and
            // "the query blew up".
            401: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "listConnections", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/connections/pending",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const list = await run(
              graph.listPendingRequests(caller.profileId, parsePagination(query)),
            );
            return {
              pending: list.map((r) =>
                Object.assign({}, profileProjection(r.profile), {
                  requestedAt: r.requestedAt.toISOString(),
                }),
              ),
            };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: PaginationQuery,
          response: {
            // Requests waiting on the caller to accept or reject.
            200: t.Object({ pending: t.Array(graphRequestSummary) }),
            401: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "listPendingConnectionRequests", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/connections/sent",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const list = await run(
              graph.listOutgoingRequests(caller.profileId, parsePagination(query)),
            );
            return {
              sent: list.map((r) =>
                Object.assign({}, profileProjection(r.profile), {
                  requestedAt: r.requestedAt.toISOString(),
                }),
              ),
            };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: PaginationQuery,
          response: {
            // The mirror of `pending` — requests the caller sent and nobody
            // has answered yet. Same row shape, different direction.
            200: t.Object({ sent: t.Array(graphRequestSummary) }),
            401: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "listSentConnectionRequests", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/connections/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const target = await resolveHandle(params.handle, set);
            if (!target) return { error: "Profile not found" };
            const status = await run(graph.getConnectionStatus(caller.profileId, target.id));
            return { status };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          response: {
            // Directional: `pending_sent` and `pending_received` are the same
            // row read from opposite ends, so a client can label the button
            // "Cancel" or "Accept" without a second call.
            200: t.Object({ status: graphConnectionStatus }),
            401: graphErrorResponse,
            404: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "getConnectionStatus", security: [{ bearerAuth: [] }] },
        },
      )
      // -------------------------------------------------------------------------
      // Blocks
      // -------------------------------------------------------------------------
      .post(
        "/blocks/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          const blocked = await resolveHandle(params.handle, set);
          if (!blocked) return { error: "Profile not found" };

          try {
            await run(graph.blockProfile(caller.profileId, blocked.id));
            set.status = 201;
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          response: {
            // 201 for the same reason as a connection request: a block row now
            // exists. Blocking also tears down any connection or pending
            // request between the two, which the empty body doesn't report —
            // clients refetch rather than patch state from this.
            201: graphOkResponse,
            400: graphErrorResponse,
            401: graphErrorResponse,
            404: graphErrorResponse,
            429: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "blockProfile", security: [{ bearerAuth: [] }] },
        },
      )
      .delete(
        "/blocks/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          const blocked = await resolveHandle(params.handle, set);
          if (!blocked) return { error: "Profile not found" };

          try {
            await run(graph.unblockProfile(caller.profileId, blocked.id));
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          response: {
            // 200, not 201: unblocking deletes a row rather than creating one.
            // Note it does NOT restore the connection the block tore down —
            // that has to be requested again.
            200: graphOkResponse,
            // `unblockProfile` fails with NotFoundError when no block exists,
            // and the handler maps every service failure here to 400.
            400: graphErrorResponse,
            401: graphErrorResponse,
            404: graphErrorResponse,
            429: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "unblockProfile", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/blocks",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          try {
            const list = await run(graph.listBlocks(caller.profileId, parsePagination(query)));
            return { blocks: list.map(profileProjection) };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: PaginationQuery,
          response: {
            // The caller's own block list, so it carries the full profile
            // projection rather than a timestamp — there is no "blockedAt" in
            // the service's return type.
            200: t.Object({ blocks: t.Array(graphProfileSummary) }),
            // A read: no rate limiter, and no handle to resolve, so 429 and
            // 404 can't happen here.
            401: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "listBlocks", security: [{ bearerAuth: [] }] },
        },
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
            if (!target) return { error: "Profile not found" };
            const blocked = await run(graph.isBlocked(caller.profileId, target.id));
            return { blocked };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          response: {
            // One direction only, per the M1 note above: `blocked` is true when
            // the CALLER has blocked the target. A client can't learn from this
            // that it has been blocked.
            200: t.Object({ blocked: t.Boolean() }),
            401: graphErrorResponse,
            // `resolveHandle` runs inside the try here, so a miss still sets
            // 404 and a lookup failure still sets 500.
            404: graphErrorResponse,
            500: graphErrorResponse,
          },
          detail: { operationId: "isProfileBlocked", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
