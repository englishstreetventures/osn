import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { buildSessionCookies } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";
import { errorResponse, publicProfile, tokenResponse } from "./response-schemas";

export function createCrossDeviceRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, sessionMetaFrom, rl, cookieConfig } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Cross-device login (QR-code mediated session transfer)
      //
      // `POST /login/cross-device/begin` — unauthenticated. Creates a pending
      //   request and returns { requestId, secret, expiresAt }.
      //
      // `POST /login/cross-device/:requestId/status` — unauthenticated. Polls
      //   for approval. Returns session tokens exactly once on approved.
      //
      // `POST /login/cross-device/:requestId/approve` — authenticated. Device A
      //   approves the request; server issues a session for device B.
      //
      // `POST /login/cross-device/:requestId/reject` — authenticated. Device A
      //   explicitly rejects the request.
      // -------------------------------------------------------------------------
      .post(
        "/login/cross-device/begin",
        async ({ set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "cross_device_begin",
            rl.crossDeviceBegin,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(
              auth.beginCrossDeviceLogin(sessionMetaFrom(headers, socketIpOf({ server, request }))),
            );
            return result;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            // The wire field is `cdlSecret`, not `secret` — the name matches
            // the log redaction deny-list entry, so renaming it here would
            // silently start logging the QR secret. `expiresAt` is Unix
            // seconds; the store holds milliseconds.
            200: t.Object({
              requestId: t.String(),
              cdlSecret: t.String(),
              expiresAt: t.Number(),
            }),
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          // Unauthenticated — device B has no session yet; that is the point.
          detail: { operationId: "beginCrossDeviceLogin" },
        },
      )
      .post(
        "/login/cross-device/:requestId/status",
        async ({ params, body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "cross_device_poll",
            rl.crossDevicePoll,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const result = await run(auth.getCrossDeviceLoginStatus(params.requestId, body.secret));
            if (result.status === "approved") {
              set.headers["set-cookie"] = buildSessionCookies(
                result.session.refreshToken,
                cookieConfig,
              );
              return {
                status: result.status,
                session: toTokenResponseCookieOnly(result.session),
                profile: result.profile,
              };
            }
            return result;
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ requestId: t.String({ pattern: "^cdl_[a-f0-9]{12}$" }) }),
          body: t.Object({ secret: t.String() }),
          response: {
            // Four shapes discriminated by `status`. Only `approved` carries
            // the session, and only once — the poll consumes the request.
            200: t.Union([
              t.Object({
                status: t.Literal("pending"),
                uaLabel: t.Union([t.String(), t.Null()]),
              }),
              t.Object({
                status: t.Literal("approved"),
                // Cookie-only token set: the refresh token went out in the
                // `Set-Cookie` header above, never in this body.
                session: tokenResponse,
                profile: publicProfile,
              }),
              t.Object({ status: t.Literal("rejected") }),
              // `expired` also covers "no such request" — an unknown id is
              // indistinguishable from a lapsed one on purpose.
              t.Object({ status: t.Literal("expired") }),
            ]),
            // A wrong secret fails as an `AuthError` → 400 `invalid_request`.
            400: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getCrossDeviceLoginStatus" },
        },
      )
      .post(
        "/login/cross-device/:requestId/approve",
        async ({ params, body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "cross_device_approve",
            rl.crossDeviceApprove,
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
            await run(
              auth.approveCrossDeviceLogin(
                params.requestId,
                body.secret,
                profile.accountId,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            return { success: true };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ requestId: t.String({ pattern: "^cdl_[a-f0-9]{12}$" }) }),
          body: t.Object({ secret: t.String() }),
          response: {
            200: t.Object({ success: t.Boolean() }),
            // Wrong secret, already-consumed or expired request — all
            // `AuthError` → 400. No explicit 403 branch on this route.
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "approveCrossDeviceLogin", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/login/cross-device/:requestId/reject",
        async ({ params, body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "cross_device_reject",
            rl.crossDeviceReject,
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
            await run(auth.rejectCrossDeviceLogin(params.requestId, body.secret));
            return { success: true };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ requestId: t.String({ pattern: "^cdl_[a-f0-9]{12}$" }) }),
          body: t.Object({ secret: t.String() }),
          response: {
            200: t.Object({ success: t.Boolean() }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "rejectCrossDeviceLogin", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
