import { Elysia, t } from "elysia";

import { buildSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";

export function createRegistrationRoutes(ctx: AuthRouteContext) {
  const {
    auth,
    run,
    handleError,
    rateLimit,
    turnstileGate,
    socketIpOf,
    sessionMetaFrom,
    rl,
    cookieConfig,
  } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Handle availability check
      // -------------------------------------------------------------------------
      .get(
        "/handle/:handle",
        async ({ params, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "handle_check",
            rl.handleCheck,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(auth.checkHandle(params.handle));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          params: t.Object({ handle: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Email-verified registration: begin (sends OTP, does not create profile)
      //
      // Always returns `{ sent: true }` (or a public error code on validation
      // failure) regardless of whether the email/handle is already taken —
      // this removes the user-enumeration oracle (S-M1).
      // -------------------------------------------------------------------------
      .post(
        "/register/begin",
        async ({ body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "register_begin",
            rl.registerBegin,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          // Turnstile bot gate (key-optional; no-op when the secret is unset).
          const tsErr = await turnstileGate("register_begin", body.turnstileToken, headers);
          if (tsErr) {
            set.status = 400;
            return tsErr;
          }
          try {
            return await run(auth.beginRegistration(body.email, body.handle, body.displayName));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            email: t.String(),
            handle: t.String(),
            displayName: t.Optional(t.String()),
            // Turnstile widget token. Optional at the schema level so the
            // endpoint still accepts requests when Turnstile is unconfigured;
            // when configured, `turnstileGate` rejects a missing/invalid value.
            turnstileToken: t.Optional(t.String()),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Email-verified registration: complete (verifies OTP, creates account + profile)
      //
      // Returns access + refresh tokens directly. The UI immediately uses the
      // returned access token to drive `/passkey/register/{begin,complete}`
      // and attests the user's first passkey. The UI refuses to dismiss
      // until enrollment succeeds; `deletePasskey` refuses to drop below 1.
      // -------------------------------------------------------------------------
      .post(
        "/register/complete",
        async ({ body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "register_complete",
            rl.registerComplete,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(
              auth.completeRegistration(
                body.email,
                body.code,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            set.status = 201;
            set.headers["set-cookie"] = buildSessionCookie(result.refreshToken, cookieConfig);
            return {
              profileId: result.profileId,
              handle: result.handle,
              email: result.email,
              session: toTokenResponseCookieOnly(result),
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            email: t.String(),
            code: t.String(),
          }),
        },
      )
  );
}
