import { Elysia, t } from "elysia";

import { EMAIL_LINK_SECRET_PATTERN, emailLinkIdPattern } from "../../services/auth/email-link";
import { EMAIL_VERIFICATION_TOKEN_MAX } from "../../services/auth/email-verification-token";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";
import { errorResponse, tokenResponse } from "./response-schemas";

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
    replaceSession,
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
          response: {
            200: t.Object({ available: t.Boolean() }),
            400: errorResponse,
            429: errorResponse,
          },
          detail: { operationId: "checkHandleAvailability" },
        },
      )
      // -------------------------------------------------------------------------
      // Sign-up: a nonce for the browser Email Verification API field
      //
      // 404 while the flag is off, so the sign-up form adds no field. Mounted
      // either way, so the API document names it. No limiter and no store
      // call: one HMAC, and the secret is single-use only once a token that
      // verifies is presented with it at begin.
      // -------------------------------------------------------------------------
      .post(
        "/register/email-verification-nonce",
        ({ set }) => {
          const minted = auth.emailVerificationNonce();
          if (!minted) {
            set.status = 404;
            return { error: "not_found" };
          }
          set.headers["cache-control"] = "no-store";
          return minted;
        },
        {
          response: {
            // `nonceSecret` stays in the tab's memory; `nonce` goes in the form.
            200: t.Object({ nonce: t.String(), nonceSecret: t.String() }),
            404: errorResponse,
          },
          detail: { operationId: "emailVerificationNonce" },
        },
      )
      // -------------------------------------------------------------------------
      // Sign-up: begin (opens an emailed-link request, creates nothing yet)
      //
      // Answers `{ requestId, claimSecret, retireSecret, pairingCode,
      // expiresAt }` (or a public error code on validation failure) whether or
      // not the email/handle is already taken — a taken address gets a request
      // whose link is never sent, and begin's answer does not tell the two
      // apart.
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
          // `previous` never skips it.
          const tsErr = await turnstileGate("register_begin", body.turnstileToken, headers);
          if (tsErr) {
            set.status = 400;
            return tsErr;
          }
          try {
            return await run(
              auth.beginRegistration(
                body.email,
                body.handle,
                body.birthdate,
                body.displayName,
                body.previous,
                body.emailVerificationToken !== undefined && body.nonceSecret !== undefined
                  ? {
                      emailVerificationToken: body.emailVerificationToken,
                      nonceSecret: body.nonceSecret,
                    }
                  : undefined,
              ),
            );
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
            // COPPA: date of birth (YYYY-MM-DD). Required; the under-13
            // gate rejects with 422 before the link is sent, and the value is
            // never persisted. See [[compliance/coppa]].
            birthdate: t.String(),
            displayName: t.Optional(t.String()),
            // Turnstile widget token. Optional at the schema level so the
            // endpoint still accepts requests when Turnstile is unconfigured;
            // when configured, `turnstileGate` rejects a missing/invalid value.
            turnstileToken: t.Optional(t.String()),
            // A sign-up begun before in this browser that this one replaces
            // (the person went back to change a field, or started again from
            // another tab). Retired only for the holder of its retire secret,
            // which can do nothing else. Held to the same patterns as the
            // status and resend routes, so a malformed pair is refused before
            // Turnstile and before any store call.
            previous: t.Optional(
              t.Object({
                requestId: t.String({ pattern: emailLinkIdPattern("registration") }),
                retireSecret: t.String({ pattern: EMAIL_LINK_SECRET_PATTERN }),
              }),
            ),
            // The browser Email Verification API field's value and the nonce
            // secret this tab was given with its nonce. Read only while the
            // flag is on; a token that does not verify is ignored and the
            // link path runs. Both are on the log redaction deny-list.
            emailVerificationToken: t.Optional(
              t.String({ maxLength: EMAIL_VERIFICATION_TOKEN_MAX }),
            ),
            nonceSecret: t.Optional(t.String({ maxLength: 128 })),
          }),
          response: {
            // `claimSecret`, `retireSecret` and `pairingCode` match log
            // redaction deny-list entries. The tab that began keeps the claim
            // secret and shows the code, and nothing else ever sees either; the
            // browser keeps the retire secret for its other tabs, and it can
            // only end the request. `expiresAt` is Unix seconds.
            200: t.Object({
              requestId: t.String(),
              claimSecret: t.String(),
              retireSecret: t.String(),
              pairingCode: t.String(),
              expiresAt: t.Number(),
            }),
            400: errorResponse,
            // COPPA: `age_restricted`, raised before the link is sent.
            422: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "beginRegistration" },
        },
      )
      // -------------------------------------------------------------------------
      // Sign-up: status, polled by the tab that began with its claim secret
      //
      // `pending` until the emailed link is confirmed; then the poll creates
      // the account and answers 201 with the session, once. Every refusal —
      // unknown or expired request, wrong claim secret, a poll that lost the
      // claim — is `expired`. The UI then enrols the first passkey with the
      // returned access token and refuses to dismiss until it has.
      // -------------------------------------------------------------------------
      .post(
        "/register/:requestId/status",
        async ({ params, body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "register_status",
            rl.registerStatus,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(
              auth.registrationStatus(
                params.requestId,
                body.claimSecret,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            if (result.status !== "complete") return result;
            set.status = 201;
            set.headers["set-cookie"] = await replaceSession(headers.cookie, result.refreshToken);
            return {
              status: result.status,
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
          params: t.Object({
            requestId: t.String({ pattern: emailLinkIdPattern("registration") }),
          }),
          body: t.Object({ claimSecret: t.String({ pattern: EMAIL_LINK_SECRET_PATTERN }) }),
          response: {
            200: t.Union([
              // The number the waiting screen shows, so a reloaded tab can
              // show it again without keeping it.
              t.Object({ status: t.Literal("pending"), pairingCode: t.Optional(t.String()) }),
              // Also "no such request" and "wrong claim secret": a stranger's
              // poll is indistinguishable from a lapsed one on purpose.
              t.Object({ status: t.Literal("expired") }),
              // The handle went to someone else while the person waited.
              t.Object({ status: t.Literal("conflict") }),
            ]),
            201: t.Object({
              status: t.Literal("complete"),
              profileId: t.String(),
              handle: t.String(),
              email: t.String(),
              // Cookie-only token set: the refresh token went out in the
              // `Set-Cookie` header above, never in this body.
              session: tokenResponse,
            }),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getRegistrationStatus" },
        },
      )
      // -------------------------------------------------------------------------
      // Sign-up: one more link for the same request
      //
      // Only the tab holding the claim secret can ask. Every link sent stays
      // usable; three in all. A taken address's request counts its Resends as
      // a free one's does and mails nothing.
      // -------------------------------------------------------------------------
      .post(
        "/register/:requestId/resend",
        async ({ params, body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "register_resend",
            rl.registerResend,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            return await run(auth.resendRegistration(params.requestId, body.claimSecret));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({
            requestId: t.String({ pattern: emailLinkIdPattern("registration") }),
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
          detail: { operationId: "resendRegistrationLink" },
        },
      )
  );
}
