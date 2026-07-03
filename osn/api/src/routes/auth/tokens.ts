import { Elysia, t } from "elysia";

import {
  buildClearSessionCookie,
  buildSessionCookie,
  readSessionCookie,
} from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";

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
            return { error: "invalid_request" };
          }
          try {
            const tokens = await run(auth.refreshTokens(refresh_token));
            set.headers["set-cookie"] = buildSessionCookie(tokens.refreshToken, cookieConfig);
            return toTokenResponseCookieOnly(tokens);
          } catch (e) {
            set.status = 400;
            return { error: "invalid_grant", message: String(e) };
          }
        },
        {
          body: t.Object({
            grant_type: t.String(),
          }),
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
      .post("/logout", async ({ set, headers }) => {
        const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
        if (cookieToken) {
          try {
            await run(auth.invalidateSession(cookieToken));
          } catch {
            // Swallow — don't leak whether the session existed.
          }
        }
        set.headers["set-cookie"] = buildClearSessionCookie(cookieConfig);
        return { success: true };
      })
  );
}
