import { Elysia, t } from "elysia";

import {
  buildClearSessionCookies,
  buildClearSessionMarkerCookie,
  buildSessionCookies,
  readSessionCookie,
} from "../../lib/cookie-session";
import { sessionStatusUnknown } from "../../lib/grant-failure";
import { metricAuthTokenRefreshRefused } from "../../metrics";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";
import { errorResponse, tokenResponse } from "./response-schemas";

/**
 * Every profile id osn-api issues: `genId`'s twelve hex digits and the dev
 * principal's fixed id (`dev-login.ts`). Ownership is the service's check.
 * The client reads a refusal here as a refused grant and signs the page out,
 * so an issued id must never fail this pattern.
 */
const PROFILE_ID_PATTERN = /^usr_[a-z0-9_]{1,64}$/;

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
          // it too.
          set.headers["cache-control"] = "no-store";

          const { grant_type, profile_id } = body as { grant_type: string; profile_id?: string };

          if (grant_type !== "refresh_token") {
            set.status = 400;
            return { error: "unsupported_grant_type" };
          }

          // Session token lives exclusively in the HttpOnly cookie —
          // body fallback was a defence-in-depth trap (rotated token never
          // returned in body, so cookieless clients broke on second refresh)
          // and was removed to reduce the log-leak surface.
          const refresh_token = readSessionCookie(headers.cookie, cookieConfig);
          if (!refresh_token) {
            set.status = 400;
            // Retract the marker: it promised a cookie that isn't here, and
            // left standing it would re-arm this pointless grant on every load.
            // Only the marker — the session cookie is already absent.
            set.headers["set-cookie"] = buildClearSessionMarkerCookie(cookieConfig);
            return { error: "invalid_request" };
          }
          // A `profile_id` that is no profile id, the empty one included, is
          // refused as a grant naming a profile the account does not own is
          // below: before anything rotates, with the marker retracted, so the
          // page signs out and its next cold load does not take up the
          // cookie's account. Never read as naming none.
          if (profile_id !== undefined && !PROFILE_ID_PATTERN.test(profile_id)) {
            metricAuthTokenRefreshRefused();
            set.status = 400;
            set.headers["set-cookie"] = buildClearSessionMarkerCookie(cookieConfig);
            return { error: "invalid_grant", message: "AuthError: Invalid or expired session" };
          }
          try {
            // `profile_id` names the profile the caller is acting as; the
            // service mints for it when the session's account owns it and
            // refuses the grant when it does not.
            const tokens = await run(auth.refreshTokens(refresh_token, profile_id));
            // The rotated cookie of the same family, so not `replaceSession`,
            // which would end the family this grant has just rotated.
            set.headers["set-cookie"] = buildSessionCookies(tokens.refreshToken, cookieConfig);
            return toTokenResponseCookieOnly(tokens);
          } catch (e) {
            set.status = 400;
            // Retract the marker unless this failure leaves the cookie's status
            // unknown. A storage blip and the benign concurrent-rotation race
            // both land here with a live cookie, and retracting on either would
            // strand a cold-start browser — the population the marker exists to
            // serve — signed out until it signs in again. A grant refused for
            // what it asked (a profile the cookie's account does not own, a
            // replaced handle naming none) retracts though the cookie is live:
            // the page that sent it signs out, and the next cold load shows
            // that rather than taking up the cookie's account. The session
            // cookie itself is never cleared here.
            if (!sessionStatusUnknown(e)) {
              set.headers["set-cookie"] = buildClearSessionMarkerCookie(cookieConfig);
            }
            return { error: "invalid_grant", message: String(e) };
          }
        },
        {
          body: t.Object({
            grant_type: t.String(),
            // Checked against `PROFILE_ID_PATTERN` in the handler, not here: a
            // schema refusal answers before the handler runs and cannot
            // retract the marker. The anchored pattern bounds the length.
            profile_id: t.Optional(t.String()),
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
