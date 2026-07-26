import { Elysia, t } from "elysia";

import { readSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";

export function createPasskeyEnrollRoutes(ctx: AuthRouteContext) {
  const {
    auth,
    run,
    handleError,
    rateLimit,
    socketIpOf,
    sessionMetaFrom,
    rl,
    cookieConfig,
    resolvePasskeyEnrollPrincipal,
  } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Passkey: begin registration
      //
      // Authenticated via `Authorization: Bearer <access_token>`. S-H1:
      // when the account already has ≥1 passkey, a fresh step-up token
      // (via `X-Step-Up-Token` header or `step_up_token` body field) is
      // REQUIRED — a stolen access token alone cannot bind a new
      // authenticator. First-passkey enrollment (bootstrap) bypasses the
      // gate because no step-up ceremony is reachable before the account
      // has any credentials.
      // -------------------------------------------------------------------------
      .post(
        "/passkey/register/begin",
        async ({ body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "passkey_register_begin",
            rl.passkeyRegisterBegin,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const principal = await resolvePasskeyEnrollPrincipal(headers.authorization);
            if (principal.unauthorized) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            const result = await run(
              auth.beginPasskeyRegistration(principal.accountId, stepUpToken),
            );
            return result.options;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            profileId: t.String(),
            step_up_token: t.Optional(t.String()),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Passkey: complete registration
      //
      // S-H1: the caller's session token is derived from the HttpOnly
      // cookie — NOT from optional body input — so H1 invalidation (every
      // other session on the account gets revoked) cannot be silently
      // skipped by a malicious caller.
      // -------------------------------------------------------------------------
      .post(
        "/passkey/register/complete",
        async ({ body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "passkey_register_complete",
            rl.passkeyRegisterComplete,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const principal = await resolvePasskeyEnrollPrincipal(headers.authorization);
            if (principal.unauthorized) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            // Identify the caller's own session so H1 invalidation spares it.
            // The cookie is the cheap path but only counts when it names a
            // live row; otherwise fall back to the access token's `osn_sid`
            // binding. Without that fallback a cookieless — but fully
            // authenticated — enrolment took the O4 branch and logged the
            // account out of every device.
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            const callerSessionHash = await run(
              auth.resolveCallerSession(principal.accountId, principal.profileId, {
                cookieSessionHash: cookieToken ? auth.hashSessionToken(cookieToken) : null,
                sessionBinding: principal.sessionBinding,
              }),
            );
            const result = await run(
              auth.completePasskeyRegistration(
                principal.accountId,
                body.attestation,
                callerSessionHash,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            return result;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            profileId: t.String(),
            attestation: t.Any(),
          }),
        },
      )
  );
}
