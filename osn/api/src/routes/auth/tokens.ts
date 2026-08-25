import { Elysia, t } from "elysia";

import {
  buildClearSessionCookies,
  buildClearSessionMarkerCookie,
  buildSessionCookies,
  readSessionCookie,
} from "../../lib/cookie-session";
import { sessionStatusUnknown } from "../../lib/grant-failure";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";
import { errorResponse, tokenResponse } from "./response-schemas";

export function createTokenRoutes(ctx: AuthRouteContext) {
  const { auth, run, cookieConfig } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Token endpoint — refresh grant only (session token in HttpOnly cookie)
      // -------------------------------------------------------------------------
      .post(
        "/token",
        async ({ body, set, headers }) => {
          // Token-endpoint response — never cached or stored (RFC 6749 §5.1,
          // RFC 6750 §5.3), and above the guards so every rejection carries
          // it too (tracker#466).
          set.headers["cache-control"] = "no-store";

          const { grant_type } = body as { grant_type: string };

          if (grant_type !== "refresh_token") {
            set.status = 400;
            return { error: "unsupported_grant_type" };
          }

          // C3: session token lives exclusively in the HttpOnly cookie —
          // body fallback was a defence-in-depth trap (rotated token never
          // returned in body, so cookieless clients broke on second refresh)
          // and was removed to reduce the log-leak surface (S-M1).
          const refresh_token = readSessionCookie(headers.cookie, cookieConfig);
          if (!refresh_token) {
            set.status = 400;
            // Retract the marker: it promised a cookie that isn't here, and
            // left standing it would re-arm this pointless grant on every load.
            // Only the marker — the session cookie is already absent.
            set.headers["set-cookie"] = buildClearSessionMarkerCookie(cookieConfig);
            return { error: "invalid_request" };
          }
          try {
            const tokens = await run(auth.refreshTokens(refresh_token));
            set.headers["set-cookie"] = buildSessionCookies(tokens.refreshToken, cookieConfig);
            return toTokenResponseCookieOnly(tokens);
          } catch (e) {
            set.status = 400;
            // Retract the marker only when this failure proves the cookie is
            // dead. A storage blip and the benign concurrent-rotation race both
            // land here with a live cookie, and retracting on either would
            // strand a cold-start browser — the population the marker exists to
            // serve — permanently signed out (S-M2). The session cookie itself
            // is never cleared here for the same reason.
            if (!sessionStatusUnknown(e)) {
              set.headers["set-cookie"] = buildClearSessionMarkerCookie(cookieConfig);
            }
            return { error: "invalid_grant", message: String(e) };
          }
        },
        {
          body: t.Object({
            grant_type: t.String(),
          }),
          response: {
            200: tokenResponse,
            // `unsupported_grant_type`, `invalid_request` (no session cookie)
            // and `invalid_grant` (rotation/expiry) all land here.
            400: errorResponse,
          },
          detail: { operationId: "refreshSession" },
        },
      )
      // -------------------------------------------------------------------------
      // Logout (server-side session destruction — Copenhagen Book C1 / C3)
      //
      // Cookie-only. The refresh-token-in-body fallback was removed: no
      // first-party flow sends a refresh token in the body any more, and
      // accepting it here kept the server one accidental-logging incident
      // away from a credential leak. Idempotent — always returns 200.
      // -------------------------------------------------------------------------
      .post(
        "/logout",
        async ({ set, headers }) => {
          const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
          if (cookieToken) {
            try {
              await run(auth.invalidateSession(cookieToken));
            } catch {
              // Swallow — don't leak whether the session existed.
            }
          }
          set.headers["set-cookie"] = buildClearSessionCookies(cookieConfig);
          return { success: true };
        },
        {
          response: { 200: t.Object({ success: t.Boolean() }) },
          detail: { operationId: "logout" },
        },
      )
  );
}
