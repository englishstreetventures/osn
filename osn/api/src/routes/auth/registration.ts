import { Elysia, t } from "elysia";

import { buildSessionCookies } from "../../lib/cookie-session";
import { EMAIL_LINK_SECRET_PATTERN, emailLinkIdPattern } from "../../services/auth/email-link";
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
          response: {
            200: t.Object({ available: t.Boolean() }),
            400: errorResponse,
            429: errorResponse,
          },
          detail: { operationId: "checkHandleAvailability" },
        },
      )
      // -------------------------------------------------------------------------
      // Sign-up: begin (opens an emailed-link request, creates nothing yet)
      //
      // Answers `{ requestId, claimSecret, expiresAt }` (or a public error code
      // on validation failure) whether or not the email/handle is already
      // taken — a taken address gets a request whose link is never sent, so no
      // answer tells the two apart.
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
            // A sign-up this tab began before and is replacing (the person
            // went back to change a field). Retired only for the holder of its
            // claim secret.
            previous: t.Optional(
              t.Object({
                requestId: t.String({ maxLength: 64 }),
                claimSecret: t.String({ maxLength: 64 }),
              }),
            ),
          }),
          response: {
            // `claimSecret` and `pairingCode` match log redaction deny-list
            // entries; the tab that began keeps the secret and shows the code,
            // and nothing else ever sees either. `expiresAt` is Unix seconds.
            200: t.Object({
              requestId: t.String(),
              claimSecret: t.String(),
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
            set.headers["set-cookie"] = buildSessionCookies(result.refreshToken, cookieConfig);
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
              t.Object({ status: t.Literal("pending") }),
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
      // usable; three in all. A taken address's request answers alike and
      // mails nothing.
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
