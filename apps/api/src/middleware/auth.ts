import type { MiddlewareHandler } from "hono";
import { Effect } from "effect";
import { sessionService } from "../services/session";
import { parseSessionToken } from "../lib/cookie";
import { DbService } from "../db";
import type { Db } from "../db";

interface AuthVariables {
  db: Db;
  familyId: string;
}

/**
 * Hono middleware that requires a valid session cookie. Sets `c.var.familyId`
 * for downstream handlers. Returns 401 (no body details — generic
 * `Unauthorized` to avoid leaking session-state information).
 */
export function sessionAuth(): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = parseSessionToken(c.req.header("Cookie") ?? null);
    if (!token) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const result = await Effect.runPromise(
      sessionService.validate(token).pipe(
        Effect.provideService(DbService, c.var.db),
        Effect.match({
          onFailure: () => null,
          onSuccess: (s) => s,
        }),
      ),
    );

    if (!result) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("familyId", result.familyId);
    return next();
  };
}
