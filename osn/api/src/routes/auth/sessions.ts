import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { buildClearSessionCookie, readSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { errorResponse, sessionSummary } from "./response-schemas";

export function createSessionRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl, cookieConfig } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Session introspection + revocation
      //
      // `GET /sessions` lists the caller's active sessions for the account,
      // marking the one currently attached to the request cookie as
      // "isCurrent". `DELETE /sessions/:id` revokes a single session by
      // its public handle (first 16 hex of the SHA-256 hash).
      // `POST /sessions/revoke-all-other` is the "sign out everywhere else"
      // button — it preserves the caller's current session.
      // -------------------------------------------------------------------------
      .get(
        "/sessions",
        async ({ headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "session_list",
            rl.sessionList,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            const currentHash = cookieToken ? auth.hashSessionToken(cookieToken) : null;
            return await run(auth.listAccountSessions(profile.accountId, currentHash));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            200: t.Object({ sessions: t.Array(sessionSummary) }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "listSessions", security: [{ bearerAuth: [] }] },
        },
      )
      .delete(
        "/sessions/:id",
        async ({ params, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "session_revoke",
            rl.sessionRevoke,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            const currentHash = cookieToken ? auth.hashSessionToken(cookieToken) : null;
            const result = await run(
              auth.revokeAccountSession(profile.accountId, params.id, currentHash),
            );
            if (result.revokedSelf) {
              set.headers["set-cookie"] = buildClearSessionCookie(cookieConfig);
            }
            return { success: true, revokedSelf: result.revokedSelf };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ id: t.String({ pattern: "^[0-9a-f]{16}$" }) }),
          response: {
            200: t.Object({ success: t.Boolean(), revokedSelf: t.Boolean() }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "revokeSession", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/sessions/revoke-all-other",
        async ({ headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "session_revoke",
            rl.sessionRevoke,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            if (!cookieToken) {
              set.status = 400;
              return { error: "invalid_request", message: "No current session" };
            }
            const currentHash = auth.hashSessionToken(cookieToken);
            await run(auth.revokeAllOtherAccountSessions(profile.accountId, currentHash));
            return { success: true };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            200: t.Object({ success: t.Boolean() }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "revokeAllOtherSessions", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
