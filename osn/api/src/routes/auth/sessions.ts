import { Effect } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { buildClearSessionCookies, readSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { errorResponse, sessionSummary } from "./response-schemas";

export function createSessionRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl, cookieConfig } = ctx;
  const { forkCireOrganiserRevoke } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Session introspection + revocation
      //
      // `GET /sessions` lists the caller's active sessions for the account,
      // marking the caller's device — the family of the session the request
      // cookie names, live or rotated out within the grace window — as
      // "isCurrent". `DELETE /sessions/:id` revokes the device one session's
      // public handle (first 16 hex of the SHA-256 hash) names: every session
      // of that session's family. `POST /sessions/revoke-all-other` is the
      // "sign out everywhere else" button — it keeps the caller's device (its
      // family) and revokes every other session.
      // -------------------------------------------------------------------------
      .get(
        "/sessions",
        async ({ headers, set, server, request }) => {
          // Per-user session metadata — never cached or stored.
          set.headers["cache-control"] = "private, no-store";

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
            // Before anything is revoked: a token whose session has ended
            // ends no session of the account.
            const staleErr = await ctx.liveSessionGate(
              "session_revoke",
              profile.accountId,
              claims,
              headers.cookie,
            );
            if (staleErr) {
              set.status = 409;
              return staleErr;
            }
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            const currentHash = cookieToken ? auth.hashSessionToken(cookieToken) : null;
            const result = await run(
              auth.revokeAccountSession(profile.accountId, params.id, currentHash),
            );
            if (result.revokedSelf) {
              set.headers["set-cookie"] = buildClearSessionCookies(cookieConfig);
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
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
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
            // Before anything is revoked. The session spared is the one the
            // check found: the cookie's, or, with no cookie or a stale one,
            // the session the token's `osn_sid` names. A caller that names no
            // live session is refused, so nothing is revoked for it.
            const live = await ctx.liveSession(
              "session_revoke_others",
              profile.accountId,
              claims,
              headers.cookie,
            );
            if (live.sessionHash === null) {
              set.status = 409;
              return live.refusal;
            }
            const currentHash = live.sessionHash;
            // Once the OSN sessions are gone, the account's cire organiser
            // sessions go too, in the background: the response never waits for
            // cire-api.
            await run(
              auth
                .revokeAllOtherAccountSessions(profile.accountId, currentHash)
                .pipe(
                  Effect.andThen(forkCireOrganiserRevoke(profile.accountId, "sign_out_everywhere")),
                ),
            );
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
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "revokeAllOtherSessions", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
