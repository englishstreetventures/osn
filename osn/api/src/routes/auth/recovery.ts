import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { buildSessionCookies } from "../../lib/cookie-session";
import { EMAIL_LINK_SECRET_PATTERN, emailLinkIdPattern } from "../../services/auth/email-link";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";
import { errorResponse, publicProfile, tokenResponse } from "./response-schemas";

export function createRecoveryRoutes(ctx: AuthRouteContext) {
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
      // Recovery codes (Copenhagen Book M2)
      //
      // POST /recovery/generate  — authenticated. Returns a fresh set of 10
      //                            single-use recovery codes as plaintext once.
      //                            Replaces any existing set. Tight rate limit.
      //
      // GET  /recovery/status    — authenticated. How many codes are left and
      //                            when the set was minted. No step-up: the
      //                            answer is what tells a user whether a
      //                            ceremony is worth starting, and it carries
      //                            no secret — counts only, never a code.
      //
      // POST /login/recovery/complete — unauthenticated. Exchanges an identifier
      //                            + recovery code for a full session + profile,
      //                            and revokes all other sessions for the account.
      // -------------------------------------------------------------------------
      .post(
        "/recovery/generate",
        async ({ body, headers, set, server, request }) => {
          // Plaintext recovery codes cross the wire here and only here —
          // never cached or stored.
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "recovery_generate",
            rl.recoveryGenerate,
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
            // M-PK1: require a fresh step-up token (passkey or OTP amr by
            // default). Access token alone is insufficient — a stolen
            // access token cannot burn the user's existing recovery codes.
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            await run(auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken));
            const result = await run(
              auth.generateRecoveryCodesForAccount(
                profile.accountId,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            // The wire field is `recoveryCodes` (not `codes`) so the
            // redaction deny-list entry actually matches in logs.
            return { recoveryCodes: result.recoveryCodes };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            step_up_token: t.Optional(t.String()),
          }),
          response: {
            // The only time the plaintext codes ever cross the wire. The
            // field is `recoveryCodes` so the log redaction deny-list
            // entry matches — renaming it here silently un-redacts them.
            200: t.Object({ recoveryCodes: t.Array(t.String()) }),
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "generateRecoveryCodes", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/recovery/status",
        async ({ headers, set, server, request }) => {
          // Account-scoped and it changes the moment a code is burnt — never
          // let a shared cache hand one account's counts to another request.
          // First statement so the 429 and both 401s carry it too.
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "recovery_status",
            rl.recoveryStatus,
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
            const counts = await run(auth.countActiveRecoveryCodes(profile.accountId));
            return counts;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            // Counts only, never a code. `generatedAt` is Unix seconds, null
            // when the account has never minted a set.
            200: t.Object({
              active: t.Number(),
              total: t.Number(),
              generatedAt: t.Union([t.Number(), t.Null()]),
            }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getRecoveryStatus", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/login/recovery/complete",
        async ({ body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "recovery_complete",
            rl.recoveryComplete,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(
              auth.completeRecoveryLogin(
                body.identifier,
                body.code,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            set.headers["set-cookie"] = buildSessionCookies(
              result.session.refreshToken,
              cookieConfig,
            );
            return {
              session: toTokenResponseCookieOnly(result.session),
              profile: result.profile,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ identifier: t.String(), code: t.String() }),
          response: {
            // Same envelope as passkey login: the refresh token stays in the
            // HttpOnly cookie, so `session` is the cookie-only token set.
            200: t.Object({ session: tokenResponse, profile: publicProfile }),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          // Unauthenticated — the recovery code IS the credential.
          detail: { operationId: "completeRecoveryLogin" },
        },
      )
      // -------------------------------------------------------------------------
      // Email + TOTP account recovery — the way back in for a user who has lost
      // the device AND never printed the codes.
      //
      // All unauthenticated. The email path is an emailed link (the shared
      // confirm routes are in `email-link.ts`); its status poll and the TOTP
      // completer end in a RESTRICTED recovery session (`aud: "osn-recovery"`,
      // 15-minute absolute lifetime) whose only privilege is enrolling a
      // passkey. Nothing here is a login factor; see
      // `[[wiki/osn/account-recovery-factors]]` §B.
      // -------------------------------------------------------------------------
      .post(
        "/login/recovery/email/begin",
        async ({ body, set, headers, server, request }) => {
          // A request and its claim secret are minted here. Nothing may cache
          // any part of this exchange — first statement, so the 400s and the
          // 429 carry it too.
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "recovery_email_begin",
            rl.recoveryEmailBegin,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          // Bot gate (key-optional, no-op until a secret is set). This endpoint
          // sends mail to a third party on an unauthenticated request, which is
          // exactly the shape Turnstile exists to slow down.
          const tsErr = await turnstileGate("recovery_email_begin", body.turnstileToken, headers);
          if (tsErr) {
            set.status = 400;
            return tsErr;
          }
          try {
            const result = await run(
              auth.beginEmailRecovery(
                body.identifier,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            set.status = 202;
            return result;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            // An email address, NOT a handle. A handle is public and this
            // endpoint puts mail in somebody's inbox; the service refuses one
            // on a syntactic check that never touches the database.
            identifier: t.String(),
            turnstileToken: t.Optional(t.String()),
          }),
          response: {
            // The SAME shape whether the address names an account or not, and
            // whether or not its link is held back by the lockout or a cap.
            // `claimSecret` and `pairingCode` match log redaction deny-list
            // entries: the tab that began keeps the secret and shows the
            // number, and nothing else sees either. `expiresAt` is Unix
            // seconds.
            202: t.Object({
              requestId: t.String(),
              claimSecret: t.String(),
              pairingCode: t.String(),
              expiresAt: t.Number(),
            }),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "beginEmailRecovery" },
        },
      )
      // -------------------------------------------------------------------------
      // Email recovery: status, polled by the tab that began with its claim
      // secret. `pending` until the emailed link is confirmed (on any device);
      // then the poll claims the request and answers 201 with the RESTRICTED
      // recovery session, once. Every refusal is `expired`. The device that
      // opened the link gets nothing.
      // -------------------------------------------------------------------------
      .post(
        "/login/recovery/email/:requestId/status",
        async ({ params, body, set, headers, server, request }) => {
          // The completing answer carries an access token.
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "recovery_email_status",
            rl.recoveryEmailStatus,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(
              auth.emailRecoveryStatus(
                params.requestId,
                body.claimSecret,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            if (result.status !== "complete") return result;
            // As `/login/recovery/complete` does. Without it
            // `completePasskeyRegistration` cannot resolve the caller's own
            // session and answers 409 `session_stale` — at the one step this
            // session exists to perform.
            set.status = 201;
            set.headers["set-cookie"] = buildSessionCookies(
              result.session.refreshToken,
              cookieConfig,
            );
            return {
              status: result.status,
              session: toTokenResponseCookieOnly(result.session),
              profile: result.profile,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({
            requestId: t.String({ pattern: emailLinkIdPattern("recovery") }),
          }),
          body: t.Object({ claimSecret: t.String({ pattern: EMAIL_LINK_SECRET_PATTERN }) }),
          response: {
            200: t.Union([
              // The number the waiting screen shows, so a reloaded tab can
              // show it again without keeping it.
              t.Object({ status: t.Literal("pending"), pairingCode: t.Optional(t.String()) }),
              // Also "no such request", "wrong claim secret" and a recovery
              // the cooldown refuses: a stranger's poll reads as a lapsed one.
              t.Object({ status: t.Literal("expired") }),
            ]),
            201: t.Object({
              status: t.Literal("complete"),
              // Cookie-only token set: the refresh token went out in the
              // `Set-Cookie` header above, never in this body.
              session: tokenResponse,
              profile: publicProfile,
            }),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getEmailRecoveryStatus" },
        },
      )
      // -------------------------------------------------------------------------
      // Email recovery: one more link for the same request. Only the tab
      // holding the claim secret can ask; three links in all. An address with
      // no account answers alike and mails nothing.
      // -------------------------------------------------------------------------
      .post(
        "/login/recovery/email/:requestId/resend",
        async ({ params, body, set, headers, server, request }) => {
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "recovery_email_resend",
            rl.recoveryEmailResend,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            return await run(
              auth.resendEmailRecovery(
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
            requestId: t.String({ pattern: emailLinkIdPattern("recovery") }),
          }),
          body: t.Object({ claimSecret: t.String({ pattern: EMAIL_LINK_SECRET_PATTERN }) }),
          response: {
            200: t.Object({
              status: t.Union([t.Literal("sent"), t.Literal("limit"), t.Literal("expired")]),
            }),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "resendEmailRecoveryLink" },
        },
      )
      .post(
        "/login/recovery/totp/complete",
        async ({ body, set, headers, server, request }) => {
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "recovery_totp_complete",
            rl.recoveryTotpComplete,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(
              auth.completeTotpRecovery(
                body.identifier,
                body.code,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            set.headers["set-cookie"] = buildSessionCookies(
              result.session.refreshToken,
              cookieConfig,
            );
            return {
              session: toTokenResponseCookieOnly(result.session),
              profile: result.profile,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ identifier: t.String(), code: t.String() }),
          response: {
            200: t.Object({ session: tokenResponse, profile: publicProfile }),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "completeTotpRecovery" },
        },
      )
      // -------------------------------------------------------------------------
      // POST /recovery/disown — the "this wasn't me" lever from the recovery
      // notice email.
      //
      // Unauthenticated by design: the person who needs it has just been signed
      // out of everything, and the token in the email IS the credential. It
      // revokes the credentials the disowned recovery enrolled, every session on
      // the account, and the recovery window itself.
      //
      // Answers the same 202 on every branch — good token, wrong token, spent,
      // expired, or an account that would be left with no passkey at all.
      // -------------------------------------------------------------------------
      .post(
        "/recovery/disown",
        async ({ body, set, headers, server, request }) => {
          // The token crosses the wire here. Nothing may cache any part of it —
          // first statement, so the 429 carries it too.
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "recovery_disown",
            rl.recoveryDisown,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(auth.disownRecovery(body.token));
            set.status = 202;
            return result;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ token: t.String() }),
          response: {
            // The SAME body whichever way it ends. A caller holding the token
            // learns nothing from the answer, and a caller guessing learns
            // nothing either; the outcome counter is where the difference lives.
            202: t.Object({ status: t.Literal("accepted") }),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "disownRecovery" },
        },
      )
  );
}
