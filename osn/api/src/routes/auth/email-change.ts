import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { EMAIL_LINK_SECRET_PATTERN, emailLinkIdPattern } from "../../services/auth/email-link";
import type { AuthRouteContext } from "./context";
import { errorResponse } from "./response-schemas";

const REQUEST_ID = t.Object({
  requestId: t.String({ pattern: emailLinkIdPattern("email_change") }),
});

const CLAIM = t.Object({ claimSecret: t.String({ pattern: EMAIL_LINK_SECRET_PATTERN }) });

export function createEmailChangeRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, sessionMetaFrom, rl } = ctx;

  /**
   * The caller's account and profile from an ordinary access token, with the
   * token's `osn_sid` binding for the live-session gate, or null for no
   * token, a token of any other audience and a profile that is gone.
   */
  const callerAccount = async (
    authorization: string | undefined,
  ): Promise<{ accountId: string; profileId: string; sessionBinding: string | null } | null> => {
    const claims = await resolveAccessTokenPrincipal(auth, authorization);
    if (!claims) return null;
    const profile = await run(auth.findProfileById(claims.profileId));
    return profile
      ? {
          accountId: profile.accountId,
          profileId: profile.id,
          sessionBinding: claims.sessionBinding,
        }
      : null;
  };

  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Email change (step-up gated)
      //
      // `POST /account/email/begin` mails a link to the NEW address. Its page
      //   confirms with the number the tab that began shows (the shared
      //   `/email-link/:requestId/confirm`), which changes nothing.
      // `POST /account/email/:requestId/status` tells that tab when the link is
      //   confirmed; `…/resend` mails another link.
      // `POST /account/email/:requestId/complete` moves the account to the new
      //   address on a confirmed request + a step-up token for `email_change`.
      //   Every other session is revoked in the same D1 batch as the update,
      //   which also records an `email_changed` security event naming this
      //   request's device; the address replaced gets a notice afterwards.
      // Each is for the account that began, and no other. Begin, resend and
      // complete also refuse a caller whose session has ended (409
      // `session_stale`), before they mail, replace or spend anything.
      // -------------------------------------------------------------------------
      .post(
        "/account/email/begin",
        async ({ body, headers, set, server, request }) => {
          // A claim secret is minted here; nothing may cache any part of it.
          set.headers["cache-control"] = "no-store";
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
            const caller = await callerAccount(headers.authorization);
            if (!caller) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const { accountId } = caller;
            // Before the begin: it replaces the account's pending change,
            // spends a begin and mails the address it names.
            const staleErr = await ctx.liveSessionGate(
              "email_change_begin",
              accountId,
              caller,
              headers.cookie,
            );
            if (staleErr) {
              set.status = 409;
              return staleErr;
            }
            return await run(auth.beginEmailChange(accountId, body.new_email));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ new_email: t.String() }),
          response: {
            // The SAME shape whether or not another account holds the new
            // address; only a free one is mailed. The address is never echoed.
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
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "beginEmailChange", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/account/email/:requestId/status",
        async ({ params, body, headers, set, server, request }) => {
          set.headers["cache-control"] = "no-store";
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "email_change_status",
            rl.emailChangeStatus,
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
            return await run(auth.emailChangeStatus(accountId, params.requestId, body.claimSecret));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: REQUEST_ID,
          body: CLAIM,
          response: {
            200: t.Union([
              t.Object({ status: t.Literal("pending"), pairingCode: t.Optional(t.String()) }),
              // The new address is proven; the tab steps up and completes.
              t.Object({ status: t.Literal("confirmed") }),
              t.Object({ status: t.Literal("expired") }),
            ]),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getEmailChangeStatus", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/account/email/:requestId/resend",
        async ({ params, body, headers, set, server, request }) => {
          set.headers["cache-control"] = "no-store";
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "email_change_resend",
            rl.emailChangeResend,
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
            // Before the request is rewritten: a Resend mails and spends the
            // mailbox's Resends.
            const staleErr = await ctx.liveSessionGate(
              "email_change_resend",
              accountId,
              caller,
              headers.cookie,
            );
            if (staleErr) {
              set.status = 409;
              return staleErr;
            }
            return await run(auth.resendEmailChange(accountId, params.requestId, body.claimSecret));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: REQUEST_ID,
          body: CLAIM,
          response: {
            200: t.Object({
              status: t.Union([t.Literal("sent"), t.Literal("limit"), t.Literal("expired")]),
            }),
            400: errorResponse,
            401: errorResponse,
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "resendEmailChangeLink", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/account/email/:requestId/complete",
        async ({ params, body, headers, set, server, request }) => {
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
            // Guard: the caller's account. Everything after it is the change.
            const caller = await callerAccount(headers.authorization);
            if (!caller) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const { accountId } = caller;
            // Before the request or the step-up token is read. The session it
            // finds is the one the sweep that follows the change spares.
            const live = await ctx.liveSession(
              "email_change_complete",
              accountId,
              caller,
              headers.cookie,
            );
            if (live.sessionHash === null) {
              set.status = 409;
              return live.refusal;
            }
            const result = await run(
              auth.completeEmailChange(
                accountId,
                caller.profileId,
                params.requestId,
                body.claimSecret,
                body.step_up_token,
                live.sessionHash,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
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
          params: REQUEST_ID,
          body: t.Object({
            claimSecret: t.String({ pattern: EMAIL_LINK_SECRET_PATTERN }),
            step_up_token: t.String(),
          }),
          response: {
            // The account's new email, echoed so the client can update its
            // cached profile without a refetch.
            200: t.Object({ email: t.String() }),
            // `step_up_token` is a required body field, so a missing one is a
            // 400 body-validation failure. An unconfirmed, spent or replaced
            // request and a stale step-up token are also 400 (`AuthError`).
            400: errorResponse,
            401: errorResponse,
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "completeEmailChange", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
