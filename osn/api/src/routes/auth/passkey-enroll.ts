import { Elysia, t } from "elysia";

import { readSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { errorResponse, publicKeyCredentialCreationOptions } from "./response-schemas";

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

  /**
   * Names the caller's own live session: the HttpOnly cookie when it names one,
   * otherwise the access token's `osn_sid` binding. Both inputs are
   * server-derived — neither is ever read from the request body (S-H1) — and
   * both routes below need the same answer, `/begin` to decide whether the
   * recovery bypass is on the table and `/complete` to spare the caller from
   * the H1 sweep.
   */
  const classifyCaller = (
    principal: {
      readonly accountId: string;
      readonly profileId: string;
      readonly sessionBinding: string | null;
    },
    cookieHeader: string | undefined,
  ) => {
    const cookieToken = readSessionCookie(cookieHeader, cookieConfig);
    return run(
      auth.classifyCallerSession(principal.accountId, principal.profileId, {
        cookieSessionHash: cookieToken ? auth.hashSessionToken(cookieToken) : null,
        sessionBinding: principal.sessionBinding,
      }),
    );
  };

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
      //
      // These two routes also accept a restricted recovery session's token
      // (`aud: "osn-recovery"`), which no other route in this service does,
      // and such a caller can pass the step-up gate as well — losing the
      // device does not delete its passkey row, so the gate would otherwise
      // block the common recovery case. See `resolvePasskeyEnrollPrincipal`.
      // The audience only makes the bypass reachable; whether it is granted
      // turns on the factor the session row records — see
      // `recoverySessionAdmitsEnrolment` in the service.
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
            // A recovery-audience caller may enrol past the step-up gate, and
            // the service grants that on the factor the session row records —
            // so name the caller's own session here, the same way `/complete`
            // does. When it cannot be named the bypass is simply unavailable
            // and the ordinary gate applies; nothing here has to fail loudly.
            const caller = principal.restricted
              ? await classifyCaller(principal, headers.cookie)
              : null;
            const recoverySessionHash = caller?._tag === "resolved" ? caller.sessionHash : null;
            const result = await run(
              auth.beginPasskeyRegistration(
                principal.accountId,
                stepUpToken,
                recoverySessionHash === null ? undefined : { recoverySessionHash },
              ),
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
          response: {
            200: publicKeyCredentialCreationOptions,
            // A missing / stale step-up token fails inside the service as an
            // `AuthError`, which `publicError` maps to 400 `invalid_request` —
            // this route has no explicit 403 branch.
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: {
            operationId: "beginPasskeyRegistration",
            security: [{ bearerAuth: [] }],
          },
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
            const caller = await classifyCaller(principal, headers.cookie);
            // S-M2: a presented-but-stale binding (session rotated out or
            // LRU-evicted) must NOT degrade to the account-wide wipe. Fail
            // closed and ask the caller to re-authenticate so the enrolment's
            // H1 sweep can spare a real "self".
            if (caller._tag === "stale") {
              set.status = 409;
              return { error: "session_stale", message: "Re-authenticate and try again." };
            }
            const callerSessionHash = caller._tag === "resolved" ? caller.sessionHash : null;
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
          response: {
            200: t.Object({ passkeyId: t.String() }),
            400: errorResponse,
            401: errorResponse,
            // S-M2: a presented-but-stale session binding.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: {
            operationId: "completePasskeyRegistration",
            security: [{ bearerAuth: [] }],
          },
        },
      )
  );
}
