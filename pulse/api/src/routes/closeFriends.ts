import { DbLive, type Db } from "@pulse/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { DEFAULT_JWKS_URL, extractClaims } from "../lib/auth";
import {
  addCloseFriend,
  isCloseFriendOf,
  listCloseFriendIds,
  removeCloseFriend,
} from "../services/closeFriends";
import { getProfileDisplays } from "../services/graphBridge";

/**
 * Pulse-scoped close-friends routes. The list lives in `pulse_close_friends`
 * and is independent of the OSN core social graph — Pulse uses it as a
 * personal signal (feed boost + invite-picker affordance), nothing else.
 *
 * Profile metadata for `GET /close-friends` is joined from OSN via the
 * graph bridge so the client gets handle/displayName/avatar without
 * having to look up each id separately.
 */
export const createCloseFriendsRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
) =>
  new Elysia({ prefix: "/close-friends" })
    .get(
      "/",
      async ({ headers, set }) => {
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        // Short private cache: the list only mutates via the same
        // POST/DELETE routes, and 30s absorbs repeat reads on rapid
        // navigation without staleness that matters in practice (P-W3).
        set.headers["cache-control"] = "private, max-age=30";
        const ids = await Effect.runPromise(
          listCloseFriendIds(claims.profileId).pipe(Effect.provide(dbLayer)),
        );
        if (ids.length === 0) return { closeFriends: [] };
        const displays = await Effect.runPromise(
          getProfileDisplays(ids).pipe(
            Effect.catchTag("GraphBridgeError", () => Effect.succeed(new Map())),
            Effect.provide(dbLayer),
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
      {},
    )
    .post(
      "/:friendId",
      async ({ params, headers, set }) => {
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        const result = await Effect.runPromise(
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
            Effect.provide(dbLayer),
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
      { params: t.Object({ friendId: t.String({ minLength: 1 }) }) },
    )
    .delete(
      "/:friendId",
      async ({ params, headers, set }) => {
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        const result = await Effect.runPromise(
          removeCloseFriend(claims.profileId, params.friendId).pipe(
            Effect.match({
              onSuccess: () => ({ ok: true }) as const,
              onFailure: (e) => {
                if (e._tag === "CloseFriendNotFound") return { _err: "not_found" as const };
                return { _err: "db" as const };
              },
            }),
            Effect.provide(dbLayer),
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
      { params: t.Object({ friendId: t.String({ minLength: 1 }) }) },
    )
    .get(
      "/:friendId/check",
      async ({ params, headers, set }) => {
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        const isCloseFriend = await Effect.runPromise(
          isCloseFriendOf(claims.profileId, params.friendId).pipe(Effect.provide(dbLayer)),
        );
        return { isCloseFriend };
      },
      { params: t.Object({ friendId: t.String({ minLength: 1 }) }) },
    );

export const closeFriendsRoutes = createCloseFriendsRoutes();
