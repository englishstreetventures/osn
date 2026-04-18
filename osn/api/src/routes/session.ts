/**
 * Session management routes — "your active sessions" UI surface.
 *
 *   GET    /sessions              — list every active session on the account
 *   DELETE /sessions/:id          — revoke one session (current or other)
 *   POST   /sessions/revoke-others — revoke every session except the caller's
 *
 * All three authenticate via Bearer access token (not the session cookie).
 * The session cookie is still read so the route can flag `is_current` and
 * distinguish `self` vs `other` revoke reasons, but the authentication
 * principal is the access token — consistent with /profiles/* (S-H1).
 */

import { DbLive, type Db } from "@osn/db/service";
import { createRateLimiter, getClientIp, type RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../lib/auth-derive";
import { readSessionCookie, type CookieSessionConfig } from "../lib/cookie-session";
import { publicError } from "../lib/public-error";
import { metricAuthRateLimited, metricSessionRevoked } from "../metrics";
import { createAuthService, type AuthConfig } from "../services/auth";
import { createSessionService } from "../services/session";

/**
 * Rate limiters for the session-management routes. Split into two:
 * reads are looser (users may refresh the session list) while writes are
 * tighter (a compromised access token shouldn't be able to mass-revoke).
 */
export type SessionRateLimiters = Readonly<{
  sessionList: RateLimiterBackend;
  sessionRevoke: RateLimiterBackend;
  sessionRevokeOthers: RateLimiterBackend;
}>;

export function createDefaultSessionRateLimiters(): SessionRateLimiters {
  return {
    sessionList: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
    sessionRevoke: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    sessionRevokeOthers: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
  };
}

/**
 * Session-id path-param validator. Sessions are keyed on SHA-256 hex, which
 * is a fixed 64-char lowercase-hex string — anything else is a malformed
 * request and rejected at the edge before it touches the service.
 */
const SESSION_ID_PATTERN = "^[a-f0-9]{64}$";

export function createSessionRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db> = DbLive,
  loggerLayer: Layer.Layer<never> = Layer.empty,
  rateLimiters: SessionRateLimiters = createDefaultSessionRateLimiters(),
  cookieConfig: CookieSessionConfig = { secure: false },
) {
  for (const [key, backend] of Object.entries(rateLimiters)) {
    if (typeof (backend as RateLimiterBackend)?.check !== "function") {
      throw new Error(`SessionRateLimiters.${key} must have a check() method`);
    }
  }

  const auth = createAuthService(authConfig);
  const svc = createSessionService(auth);

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(dbLayer), Effect.provide(loggerLayer)) as Effect.Effect<
        A,
        never,
        never
      >,
    );

  const handleError = (e: unknown) => publicError(e, loggerLayer);

  async function rateLimit(
    headers: Record<string, string | undefined>,
    endpoint: "session_list" | "session_revoke" | "session_revoke_others",
    limiter: RateLimiterBackend,
  ): Promise<{ error: string } | null> {
    const ip = getClientIp(headers);
    let allowed: boolean;
    try {
      allowed = await limiter.check(ip);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
    return null;
  }

  /**
   * Resolves the caller's accountId from a Bearer token AND reads the
   * current session cookie (so `is_current` + self/other revoke reasons
   * work). Both are optional beyond the Bearer token — missing cookie is
   * fine, the UI just won't flag the current row.
   */
  async function resolvePrincipal(
    headers: Record<string, string | undefined>,
  ): Promise<
    | { unauthorized: true }
    | { unauthorized: false; accountId: string; currentSessionHash: string | null }
  > {
    const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
    if (!claims) return { unauthorized: true };
    const profile = await run(auth.findProfileById(claims.profileId));
    if (!profile) return { unauthorized: true };

    const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
    const currentSessionHash = cookieToken ? svc.hashSessionToken(cookieToken) : null;

    return { unauthorized: false, accountId: profile.accountId, currentSessionHash };
  }

  return new Elysia({ prefix: "" })
    .get("/sessions", async ({ headers, set }) => {
      const rlErr = await rateLimit(headers, "session_list", rateLimiters.sessionList);
      if (rlErr) {
        set.status = 429;
        return rlErr;
      }
      const principal = await resolvePrincipal(headers);
      if (principal.unauthorized) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      try {
        return await run(svc.listSessions(principal.accountId, principal.currentSessionHash));
      } catch (e) {
        const { status, body } = handleError(e);
        set.status = status;
        return body;
      }
    })
    .delete(
      "/sessions/:id",
      async ({ params, headers, set }) => {
        const rlErr = await rateLimit(headers, "session_revoke", rateLimiters.sessionRevoke);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        const principal = await resolvePrincipal(headers);
        if (principal.unauthorized) {
          set.status = 401;
          return { error: "unauthorized" };
        }
        // Use `Effect.either` so the service error surfaces as a plain
        // tagged value — cleaner than unwrapping a runPromise FiberFailure
        // just to branch on `_tag`.
        const result = await run(
          Effect.either(
            svc.revokeSession(principal.accountId, params.id, principal.currentSessionHash),
          ),
        );
        if (result._tag === "Right") {
          metricSessionRevoked(result.right.wasCurrent ? "self" : "other");
          return { success: true, was_current: result.right.wasCurrent };
        }
        // SessionNotFoundError → 404. Both "doesn't exist" and "belongs to
        // someone else" collapse here — same error, no oracle.
        if (result.left._tag === "SessionNotFoundError") {
          set.status = 404;
          return { error: "not_found" };
        }
        const { status, body } = handleError(result.left);
        set.status = status;
        return body;
      },
      {
        params: t.Object({ id: t.String({ pattern: SESSION_ID_PATTERN }) }),
      },
    )
    .post("/sessions/revoke-others", async ({ headers, set }) => {
      const rlErr = await rateLimit(
        headers,
        "session_revoke_others",
        rateLimiters.sessionRevokeOthers,
      );
      if (rlErr) {
        set.status = 429;
        return rlErr;
      }
      const principal = await resolvePrincipal(headers);
      if (principal.unauthorized) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      try {
        const result = await run(
          svc.revokeOtherSessions(principal.accountId, principal.currentSessionHash),
        );
        metricSessionRevoked("revoke_all_others");
        return { success: true, revoked: result.revoked };
      } catch (e) {
        const { status, body } = handleError(e);
        set.status = status;
        return body;
      }
    });
}
