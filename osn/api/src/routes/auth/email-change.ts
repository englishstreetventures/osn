import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { readSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";

export function createEmailChangeRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl, cookieConfig } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Email change (step-up gated)
      //
      // `POST /account/email/begin` sends an OTP to the NEW email address.
      // `POST /account/email/complete` swaps the account's email on a matching
      //   OTP + a valid step-up token (passkey or OTP amr). All other sessions
      //   are revoked atomically in the same transaction as the email update.
      // -------------------------------------------------------------------------
      .post(
        "/account/email/begin",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "email_change_begin",
            rl.emailChangeBegin,
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
            return await run(auth.beginEmailChange(profile.accountId, body.new_email));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ new_email: t.String() }),
        },
      )
      .post(
        "/account/email/complete",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "email_change_complete",
            rl.emailChangeComplete,
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
              auth.completeEmailChange(
                profile.accountId,
                body.code,
                body.step_up_token,
                currentHash,
              ),
            );
            return { email: result.email };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            code: t.String(),
            step_up_token: t.String(),
          }),
        },
      )
  );
}
