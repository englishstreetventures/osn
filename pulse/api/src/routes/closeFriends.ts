import { DbLive, type Db } from "@pulse/db/service";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia, t } from "elysia";

import { makeCallerResolver } from "../lib/caller";
import { DEFAULT_VERIFICATION, type OsnTokenVerification } from "../lib/jwks";
import { checkWriteRateLimit, createDefaultWriteRateLimiter } from "../lib/rate-limit";
import {
  addCloseFriend,
  isCloseFriendOf,
  listCloseFriendIds,
  removeCloseFriend,
} from "../services/closeFriends";
import { getConnectionIds, getProfileDisplays } from "../services/graphBridge";

/**
 * Pulse-scoped close-friends routes. The list lives in `pulse_close_friends`
 * and is independent of the OSN core social graph — Pulse uses it as a
 * personal signal (feed boost + invite-picker affordance), nothing else.
 *
 * Profile metadata for `GET /close-friends` is joined from OSN via the
 * graph bridge so the client gets handle/displayName/avatar without
 * having to look up each id separately.
 *
 * `GET /close-friends/candidates` serves the picker: the caller's OSN
 * connections with the same display fields. Clients can't read the graph
 * themselves — a browser holds a Pulse session cookie, not an OSN token —
 * so the fan-out over both bridge calls happens here.
 */
export const createCloseFriendsRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  verification: OsnTokenVerification = DEFAULT_VERIFICATION,
  _testKey?: CryptoKey,
  /**
   * Per-USER limiter (keyed on `claims.profileId`) shared by the add +
   * remove list mutations (W4). Default in-memory; production wires Redis at
   * the composition root.
   */
  mutateRateLimiter: RateLimiterBackend = createDefaultWriteRateLimiter("close_friend_mutate"),
) => {
  // Layer graph built once per factory (convention: see osn/api/src/lib/route-runtime.ts) — not per request.
  const runtime = ManagedRuntime.make(dbLayer);
  const resolveCaller = makeCallerResolver({ runtime, verification, testKey: _testKey });
  return new Elysia({ prefix: "/close-friends" })
    .get(
      "/",
      async ({ headers, set }) => {
        const claims = await resolveCaller(headers);
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        // Short private cache: the list only mutates via the same
        // POST/DELETE routes, and 30s absorbs repeat reads on rapid
        // navigation without staleness that matters in practice (P-W3).
        set.headers["cache-control"] = "private, max-age=30";
        const ids = await runtime.runPromise(listCloseFriendIds(claims.profileId));
        if (ids.length === 0) return { closeFriends: [] };
        const displays = await runtime.runPromise(
          getProfileDisplays(ids).pipe(
            Effect.catchTag("GraphBridgeError", () => Effect.succeed(new Map())),
          ),
        );
        return {
          closeFriends: ids.map((id) => {
            const display = displays.get(id) ?? null;
            return {
              profileId: id,
              handle: display?.handle ?? null,
              displayName: display?.displayName ?? null,
              avatarUrl: display?.avatarUrl ?? null,
            };
          }),
        };
      },
      {
        response: {
          200: t.Object({
            closeFriends: t.Array(
              t.Object({
                profileId: t.String(),
                handle: t.Nullable(t.String()),
                displayName: t.Nullable(t.String()),
                avatarUrl: t.Nullable(t.String()),
              }),
            ),
          }),
          401: t.Object({ message: t.String() }),
        },
        detail: { operationId: "listCloseFriends", security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/candidates",
      async ({ headers, set }) => {
        const claims = await resolveCaller(headers);
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        // The eligible set is exactly the caller's accepted connections —
        // `addCloseFriend` rejects anything else with `not_a_connection`, so
        // the picker and the write gate read the same list.
        const connections = await runtime.runPromise(
          getConnectionIds(claims.profileId).pipe(
            Effect.flatMap((ids) => getProfileDisplays([...ids])),
            Effect.map((displays) => [...displays.values()]),
            Effect.catchTag("GraphBridgeError", () => Effect.succeed(null)),
          ),
        );
        if (connections === null) {
          // Unlike `GET /close-friends`, there's nothing to degrade to: an
          // unnamed picker row is unusable, so say the graph is unreachable.
          set.status = 502;
          return { error: "Connections unavailable" } as const;
        }
        set.headers["cache-control"] = "private, max-age=30";
        return {
          connections: connections
            .map((p) => ({
              profileId: p.id,
              handle: p.handle,
              displayName: p.displayName,
              avatarUrl: p.avatarUrl,
            }))
            .toSorted((a, b) =>
              (a.displayName ?? a.handle).localeCompare(b.displayName ?? b.handle),
            ),
        };
      },
      {
        response: {
          200: t.Object({
            connections: t.Array(
              t.Object({
                profileId: t.String(),
                handle: t.String(),
                displayName: t.Nullable(t.String()),
                avatarUrl: t.Nullable(t.String()),
              }),
            ),
          }),
          401: t.Object({ message: t.String() }),
          502: t.Object({ error: t.String() }),
        },
        detail: { operationId: "listCloseFriendCandidates", security: [{ bearerAuth: [] }] },
      },
    )
    .post(
      "/:friendId",
      async ({ params, headers, set }) => {
        const claims = await resolveCaller(headers);
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        if (
          !(await checkWriteRateLimit(mutateRateLimiter, "close_friend_mutate", claims.profileId))
        ) {
          set.status = 429;
          return { error: "Too many requests" } as const;
        }
        const result = await runtime.runPromise(
          addCloseFriend(claims.profileId, params.friendId).pipe(
            Effect.match({
              onSuccess: () => ({ ok: true }) as const,
              onFailure: (e) => {
                if (e._tag === "NotEligibleForCloseFriend") {
                  return { _err: "not_eligible" as const, reason: e.reason };
                }
                if (e._tag === "GraphBridgeError") return { _err: "bridge" as const };
                return { _err: "db" as const };
              },
            }),
          ),
        );
        if ("_err" in result) {
          if (result._err === "not_eligible") {
            set.status = 422;
            return { error: result.reason } as const;
          }
          set.status = 500;
          return { error: "Failed to add close friend" } as const;
        }
        set.status = 201;
        return result;
      },
      {
        params: t.Object({ friendId: t.String({ minLength: 1 }) }),
        response: {
          201: t.Object({ ok: t.Literal(true) }),
          401: t.Object({ message: t.String() }),
          422: t.Object({ error: t.String() }),
          429: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String() }),
        },
        detail: { operationId: "addCloseFriend", security: [{ bearerAuth: [] }] },
      },
    )
    .delete(
      "/:friendId",
      async ({ params, headers, set }) => {
        const claims = await resolveCaller(headers);
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        if (
          !(await checkWriteRateLimit(mutateRateLimiter, "close_friend_mutate", claims.profileId))
        ) {
          set.status = 429;
          return { error: "Too many requests" } as const;
        }
        const result = await runtime.runPromise(
          removeCloseFriend(claims.profileId, params.friendId).pipe(
            Effect.match({
              onSuccess: () => ({ ok: true }) as const,
              onFailure: (e) => {
                if (e._tag === "CloseFriendNotFound") return { _err: "not_found" as const };
                return { _err: "db" as const };
              },
            }),
          ),
        );
        if ("_err" in result) {
          if (result._err === "not_found") {
            set.status = 404;
            return { message: "Close friend not found" } as const;
          }
          set.status = 500;
          return { error: "Failed to remove close friend" } as const;
        }
        return result;
      },
      {
        params: t.Object({ friendId: t.String({ minLength: 1 }) }),
        response: {
          200: t.Object({ ok: t.Literal(true) }),
          401: t.Object({ message: t.String() }),
          404: t.Object({ message: t.String() }),
          429: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String() }),
        },
        detail: { operationId: "removeCloseFriend", security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/:friendId/check",
      async ({ params, headers, set }) => {
        const claims = await resolveCaller(headers);
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        const isCloseFriend = await runtime.runPromise(
          isCloseFriendOf(claims.profileId, params.friendId),
        );
        return { isCloseFriend };
      },
      {
        params: t.Object({ friendId: t.String({ minLength: 1 }) }),
        response: {
          200: t.Object({ isCloseFriend: t.Boolean() }),
          401: t.Object({ message: t.String() }),
        },
        detail: { operationId: "checkIsCloseFriend", security: [{ bearerAuth: [] }] },
      },
    );
};
