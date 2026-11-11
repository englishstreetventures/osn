import { Elysia, t } from "elysia";

import { EMAIL_LINK_ID_PATTERN, EMAIL_LINK_SECRET_PATTERN } from "../../services/auth/email-link";
import type { AuthRouteContext } from "./context";
import { errorResponse } from "./response-schemas";

/**
 * The two routes the page an emailed link opens calls, shared by every flow
 * that emails a link. Both take the link's secret in a `POST` body — never a
 * query string, which would reach logs — and both answer `expired` for every
 * refusal, so the page cannot tell an unknown request from a wrong secret or a
 * spent one. Neither sets a cookie or returns a token: the session goes to the
 * tab that began, through its own flow's status route.
 *
 * There is no `GET` on either path. Mail scanners open links before people do;
 * the page reads and confirms only from script, and confirms only on a press.
 */
export function createEmailLinkRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, sessionMetaFrom, rl } = ctx;
  const requestIdParam = t.Object({ requestId: t.String({ pattern: EMAIL_LINK_ID_PATTERN }) });
  const linkSecret = t.String({ pattern: EMAIL_LINK_SECRET_PATTERN });
  return (
    new Elysia()
      // -----------------------------------------------------------------------
      // The candidates the confirm page offers where the reader picks: the
      // waiting screen's number among decoys, sorted ascending. The number was
      // drawn uniformly from them, so its place in the list says nothing about
      // which is right. Needs the link's secret; a wrong one is counted as a
      // wrong confirm is. Where the reader types the number (recovery) there is
      // no list, and the read answers `expired`.
      // -----------------------------------------------------------------------
      .post(
        "/email-link/:requestId/candidates",
        async ({ params, body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "email_link_candidates",
            rl.emailLinkCandidates,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            return await run(auth.emailLinkCandidates(params.requestId, body.linkSecret));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: requestIdParam,
          body: t.Object({ linkSecret }),
          response: {
            200: t.Union([
              t.Object({
                status: t.Literal("ready"),
                pairingCandidates: t.Array(t.String()),
              }),
              // The request is already confirmed: the page shows that, and
              // offers no second pick.
              t.Object({ status: t.Literal("confirmed") }),
              t.Object({ status: t.Literal("expired") }),
            ]),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getEmailLinkCandidates" },
        },
      )
      // -----------------------------------------------------------------------
      // Confirm: the link's secret and the number the reader picked or typed.
      // The confirm step requires the number shown on the waiting screen; a
      // wrong one ends the request. `none` says the reader did not ask: it
      // ends the request too, and answers `declined`, again when repeated.
      // -----------------------------------------------------------------------
      .post(
        "/email-link/:requestId/confirm",
        async ({ params, body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "email_link_confirm",
            rl.emailLinkConfirm,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const status = await run(
              auth.confirmEmailLink(
                params.requestId,
                { linkSecret: body.linkSecret, pairingPick: body.pairingPick },
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            return { status };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: requestIdParam,
          body: t.Object({
            linkSecret,
            // Checked against the request's flow by the service: a candidate
            // where the reader picks, typed digits where they type, or `none`.
            // Anything else is refused like every other refusal, never with an
            // error of its own; the length bound only keeps the body small.
            pairingPick: t.String({ maxLength: 64 }),
          }),
          response: {
            200: t.Object({
              status: t.Union([
                t.Literal("confirmed"),
                t.Literal("declined"),
                t.Literal("expired"),
              ]),
            }),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "confirmEmailLink" },
        },
      )
  );
}
