import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import type { AuthRouteContext } from "./context";
import { errorResponse, securityEventSummary } from "./response-schemas";

export function createSecurityEventRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Security events (M-PK1b)
      //
      // `GET /account/security-events` lists the caller's still-unacknowledged
      // security events so the Settings banner can surface "was this you?"
      // prompts without relying on the confirmation email reaching the inbox.
      // `POST /account/security-events/:id/ack` dismisses the banner for a
      // single event and is idempotent on missing / already-acked IDs.
      // -------------------------------------------------------------------------
      .get(
        "/account/security-events",
        async ({ headers, set, server, request }) => {
          // Per-user and sensitive (lists auth events) — never cached or
          // stored by a shared cache or the browser (tracker#346).
          set.headers["cache-control"] = "private, no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "security_event_list",
            rl.securityEventList,
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
            return await run(auth.listUnacknowledgedSecurityEvents(profile.accountId));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            // Unacknowledged events only — the acked ones stay in the table
            // but never come back here.
            200: t.Object({ events: t.Array(securityEventSummary) }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "listSecurityEvents", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/account/security-events/:id/ack",
        async ({ params, body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "security_event_ack",
            rl.securityEventAck,
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
            // S-M1: step-up gate. Access token alone is insufficient — an
            // XSS-captured token must not be able to silently dismiss the
            // banner that exists precisely to notice that compromise.
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            const result = await run(
              auth.acknowledgeSecurityEvent(profile.accountId, params.id, stepUpToken),
            );
            return { acknowledged: result.acknowledged };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ id: t.String({ pattern: "^sev_[a-f0-9]{12}$" }) }),
          body: t.Object({ step_up_token: t.Optional(t.String()) }),
          response: {
            // Boolean here, a COUNT on `ack-all` — same key, different type,
            // so the two routes cannot share one schema. False means the id
            // matched nothing or was already acked; both are idempotent, not
            // errors.
            200: t.Object({ acknowledged: t.Boolean() }),
            400: errorResponse,
            401: errorResponse,
            // No step-up token presented at all. A presented-but-invalid one
            // fails inside the service as an `AuthError` → 400.
            403: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "acknowledgeSecurityEvent", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/account/security-events/ack-all",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "security_event_ack",
            rl.securityEventAck,
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
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            const result = await run(
              auth.acknowledgeAllSecurityEvents(profile.accountId, stepUpToken),
            );
            return { acknowledged: result.acknowledged };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({ step_up_token: t.Optional(t.String()) }),
          response: {
            // A COUNT of the rows this call acked — not the boolean the
            // single-event route returns.
            200: t.Object({ acknowledged: t.Number() }),
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "acknowledgeAllSecurityEvents", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
