import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import type { AuthRouteContext } from "./context";
import {
  errorResponse,
  publicKeyCredentialRequestOptions,
  stepUpTokenResponse,
} from "./response-schemas";

export function createStepUpRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Step-up (sudo) — passkey + OTP ceremonies that mint a short-lived
      // JWT required for sensitive operations (recovery generate, email
      // change). All routes authenticate via Bearer access token so the
      // account is known up-front; the challenge / OTP stores are keyed
      // by accountId to keep the ceremony scoped to the caller.
      // -------------------------------------------------------------------------
      .post(
        "/step-up/passkey/begin",
        async ({ headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "step_up_passkey_begin",
            rl.stepUpPasskeyBegin,
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
            return await run(auth.beginStepUpPasskey(profile.accountId));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            200: t.Object({ options: publicKeyCredentialRequestOptions }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "beginStepUpPasskey", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/step-up/passkey/complete",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "step_up_passkey_complete",
            rl.stepUpPasskeyComplete,
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
            const result = await run(
              auth.completeStepUpPasskey(profile.accountId, body.assertion, body.purpose),
            );
            return {
              step_up_token: result.stepUpToken,
              expires_in: result.expiresIn,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          // S-C1: optional `purpose` binds the minted token to a specific
          // destructive operation (e.g. "account_delete"). Verifiers that
          // require a purpose reject tokens minted for any other purpose.
          body: t.Object({
            assertion: t.Any(),
            purpose: t.Optional(
              t.Union([
                t.Literal("account_delete"),
                t.Literal("account_export"),
                t.Literal("pulse_app_delete"),
                t.Literal("zap_app_delete"),
                t.Literal("recovery_generate"),
                t.Literal("passkey_register"),
                t.Literal("passkey_delete"),
                t.Literal("email_change"),
                t.Literal("security_event_ack"),
              ]),
            ),
          }),
          response: {
            200: stepUpTokenResponse,
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "completeStepUpPasskey", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/step-up/otp/begin",
        async ({ headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "step_up_otp_begin",
            rl.stepUpOtpBegin,
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
            return await run(auth.beginStepUpOtp(profile.accountId));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            // `sent` is always true on the success path — the OTP send is
            // awaited, so a transport failure surfaces as an error status
            // rather than `{ sent: false }`.
            200: t.Object({ sent: t.Boolean() }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "beginStepUpOtp", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/step-up/otp/complete",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "step_up_otp_complete",
            rl.stepUpOtpComplete,
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
            const result = await run(
              auth.completeStepUpOtp(profile.accountId, body.code, body.purpose),
            );
            return {
              step_up_token: result.stepUpToken,
              expires_in: result.expiresIn,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          // S-C1: see /step-up/passkey/complete for the purpose-claim rationale.
          body: t.Object({
            code: t.String(),
            purpose: t.Optional(
              t.Union([
                t.Literal("account_delete"),
                t.Literal("account_export"),
                t.Literal("pulse_app_delete"),
                t.Literal("zap_app_delete"),
                t.Literal("recovery_generate"),
                t.Literal("passkey_register"),
                t.Literal("passkey_delete"),
                t.Literal("email_change"),
                t.Literal("security_event_ack"),
              ]),
            ),
          }),
          response: {
            200: stepUpTokenResponse,
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "completeStepUpOtp", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
