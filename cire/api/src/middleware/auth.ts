import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { parseSessionToken } from "../lib/cookie";
import { runCire } from "../observability";
import { sessionService } from "../services/session";

/**
 * Elysia plugin that requires a valid session cookie. Derives `familyId`
 * for downstream handlers. Returns 401 (no body details — generic
 * `Unauthorized` to avoid leaking session-state information).
 */
export function sessionAuth(db: Db) {
  return (
    new Elysia()
      // Scoped so the derive/onBeforeHandle lift into the route instance that
      // `.use`s this plugin (and no further) — same caveat as the shared
      // osn-auth-client Elysia adapter.
      .derive({ as: "scoped" }, async ({ request }) => {
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
