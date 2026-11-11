import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { EMAIL_LINK_SECRET_PATTERN, emailLinkIdPattern } from "../../services/auth/email-link";
import type { AuthRouteContext } from "./context";
import {
  errorResponse,
  publicKeyCredentialRequestOptions,
  stepUpTokenResponse,
} from "./response-schemas";

/** Every purpose a step-up token may name. */
const PURPOSE = t.Union([
  t.Literal("account_delete"),
  t.Literal("account_export"),
  t.Literal("pulse_app_delete"),
  t.Literal("zap_app_delete"),
  t.Literal("recovery_generate"),
  t.Literal("passkey_register"),
  t.Literal("passkey_delete"),
  t.Literal("email_change"),
  t.Literal("security_event_ack"),
  t.Literal("totp_enroll"),
  t.Literal("totp_disable"),
]);

export function createStepUpRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl, sessionMetaFrom } = ctx;

  /**
   * The caller's account and profile from an ordinary access token, or null
   * for no token, a token of any other audience (a restricted recovery
   * session is refused here) and a profile that is gone.
   */
  const callerAccount = async (
    authorization: string | undefined,
  ): Promise<{ accountId: string; profileId: string } | null> => {
    const claims = await resolveAccessTokenPrincipal(auth, authorization);
    if (!claims) return null;
    const profile = await run(auth.findProfileById(claims.profileId));
    return profile ? { accountId: profile.accountId, profileId: profile.id } : null;
  };

  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Step-up (sudo) — passkey, emailed-link and authenticator ceremonies
      // that mint a short-lived JWT required for sensitive operations
      // (recovery generate, email change). All routes authenticate via Bearer
      // access token so the account is known up-front; each ceremony's state
      // is scoped to the caller's account.
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
            // Before the challenge is taken: a token whose session has ended
            // mints nothing and leaves the parked challenge in place.
            const staleErr = await ctx.liveSessionGate(
              "step_up_passkey_complete",
              profile.accountId,
              claims,
              headers.cookie,
            );
            if (staleErr) {
              set.status = 409;
              return staleErr;
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
          // Optional `purpose` binds the minted token to a specific
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
                t.Literal("totp_enroll"),
                t.Literal("totp_disable"),
              ]),
            ),
          }),
          response: {
            200: stepUpTokenResponse,
            400: errorResponse,
            401: errorResponse,
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "completeStepUpPasskey", security: [{ bearerAuth: [] }] },
        },
      )
      // -------------------------------------------------------------------------
      // Step-up by emailed link. Begin mails a link to the account's own
      // address for ONE purpose, fixed here; the link's page confirms it with
      // the number this tab shows (shared `/email-link/:requestId/confirm`),
      // which mints nothing. This tab, signed in as the same account and
      // holding the claim secret, polls status and gets the step-up token,
      // once. Every refusal of a poll or a Resend is `expired`.
      // -------------------------------------------------------------------------
      .post(
        "/step-up/email/begin",
        async ({ body, headers, set, server, request }) => {
          // A claim secret is minted here; nothing may cache any part of it.
          set.headers["cache-control"] = "no-store";
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "step_up_email_begin",
            rl.stepUpEmailBegin,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const caller = await callerAccount(headers.authorization);
            if (!caller) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const { accountId } = caller;
            return await run(
              auth.beginStepUpEmail(
                accountId,
                body.purpose,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          // The purpose the minted token will name. Required: every gate
          // names one, so a purposeless token verifies nowhere.
          body: t.Object({
            purpose: PURPOSE,
          }),
          response: {
            // `claimSecret` and `pairingCode` match log redaction deny-list
            // entries. `expiresAt` is Unix seconds.
            200: t.Object({
              requestId: t.String(),
              claimSecret: t.String(),
              pairingCode: t.String(),
              expiresAt: t.Number(),
            }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "beginStepUpEmail", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/step-up/email/:requestId/status",
        async ({ params, body, headers, set, server, request }) => {
          // The completing answer carries a step-up token.
          set.headers["cache-control"] = "no-store";
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "step_up_email_status",
            rl.stepUpEmailStatus,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const caller = await callerAccount(headers.authorization);
            if (!caller) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const { accountId } = caller;
            const result = await run(
              auth.stepUpEmailStatus(
                accountId,
                caller.profileId,
                params.requestId,
                body.claimSecret,
              ),
            );
            if (result.status !== "complete") return result;
            return {
              status: result.status,
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
          params: t.Object({
            requestId: t.String({ pattern: emailLinkIdPattern("step_up") }),
          }),
          body: t.Object({ claimSecret: t.String({ pattern: EMAIL_LINK_SECRET_PATTERN }) }),
          response: {
            200: t.Union([
              // The number the waiting screen shows, so a reloaded tab can
              // show it again without keeping it.
              t.Object({ status: t.Literal("pending"), pairingCode: t.Optional(t.String()) }),
              // Also "no such request", "wrong claim secret", another
              // account's request and an address changed since begin.
              t.Object({ status: t.Literal("expired") }),
              t.Object({
                status: t.Literal("complete"),
                step_up_token: t.String(),
                expires_in: t.Number(),
              }),
            ]),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getStepUpEmailStatus", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/step-up/email/:requestId/resend",
        async ({ params, body, headers, set, server, request }) => {
          set.headers["cache-control"] = "no-store";
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "step_up_email_resend",
            rl.stepUpEmailResend,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const caller = await callerAccount(headers.authorization);
            if (!caller) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const { accountId } = caller;
            return await run(
              auth.resendStepUpEmail(
                accountId,
                params.requestId,
                body.claimSecret,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({
            requestId: t.String({ pattern: emailLinkIdPattern("step_up") }),
          }),
          body: t.Object({ claimSecret: t.String({ pattern: EMAIL_LINK_SECRET_PATTERN }) }),
          response: {
            200: t.Object({
              status: t.Union([t.Literal("sent"), t.Literal("limit"), t.Literal("expired")]),
            }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "resendStepUpEmailLink", security: [{ bearerAuth: [] }] },
        },
      )
      // No `/step-up/totp/begin` counterpart, and that is not an omission: TOTP
      // is challenge-free, so a `begin` would have nothing to mint, park or
      // send. Whether this route is usable at all is what `GET /totp/status`
      // answers.
      .post(
        "/step-up/totp/complete",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "step_up_totp_complete",
            rl.stepUpTotpComplete,
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
            // Before the code is checked: a token whose session has ended
            // mints nothing, records no TOTP step and counts no guess.
            const staleErr = await ctx.liveSessionGate(
              "step_up_totp_complete",
              profile.accountId,
              claims,
              headers.cookie,
            );
            if (staleErr) {
              set.status = 409;
              return staleErr;
            }
            const result = await run(
              auth.completeStepUpTotp(profile.accountId, body.code, body.purpose),
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
          // See /step-up/passkey/complete for the purpose-claim rationale.
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
                t.Literal("totp_enroll"),
                t.Literal("totp_disable"),
              ]),
            ),
          }),
          response: {
            200: stepUpTokenResponse,
            400: errorResponse,
            401: errorResponse,
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "completeStepUpTotp", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
