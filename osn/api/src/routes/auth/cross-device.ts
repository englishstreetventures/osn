import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { buildSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";

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
      .post("/login/cross-device/begin", async ({ set, headers, server, request }) => {
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
      })
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
              set.headers["set-cookie"] = buildSessionCookie(
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
        },
      )
  );
}
