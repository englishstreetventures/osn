import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { parseSessionToken } from "../lib/cookie";
import { runCire } from "../observability";
import { sessionService } from "../services/session";

/**
 * Elysia plugin that requires a valid session cookie. Resolves `familyId`
 * for downstream handlers. Returns 401 (no body details — generic
 * `Unauthorized` to avoid leaking session-state information).
 *
 * The lookup is a `resolve`, not a `derive`: it runs in the before-handle
 * phase, in `.use` order, so a route that mounts `rateLimitMiddleware` first
 * answers a refused request with 429 before the session query reaches the
 * database. A `derive` would run in the transform phase, ahead of every
 * limiter whatever the order.
 */
export function sessionAuth(db: Db) {
  return (
    new Elysia()
      // Scoped so the resolve/onBeforeHandle lift into the route instance that
      // `.use`s this plugin (and no further) — same caveat as the shared
      // osn-auth-client Elysia adapter.
      .resolve({ as: "scoped" }, async ({ request }) => {
        const token = parseSessionToken(request.headers.get("cookie"));
        if (!token) return { familyId: undefined as string | undefined };

        const session = await runCire(
          sessionService.validate(token).pipe(
            Effect.provideService(DbService, db),
            Effect.match({
              onFailure: () => null,
              onSuccess: (s) => s,
            }),
          ),
        );
        return { familyId: session?.familyId };
      })
      .onBeforeHandle({ as: "scoped" }, ({ familyId, set }) => {
        if (!familyId) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
      })
  );
}
