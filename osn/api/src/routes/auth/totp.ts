/**
 * TOTP (RFC 6238) routes — enrol, confirm, remove, report.
 *
 * The step-up ceremony that CONSUMES a TOTP code lives with the other step-up
 * routes in `./step-up.ts`; these four are the credential's own lifecycle. See
 * `[[wiki/systems/totp]]`.
 */

import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import type { AuthRouteContext } from "./context";
import { errorResponse } from "./response-schemas";

export function createTotpRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, sessionMetaFrom, rl } = ctx;

  return new Elysia()
    .post(
      "/totp/enroll/begin",
      async ({ body, headers, set, server, request }) => {
        // The shared secret and the otpauth:// URI cross the wire here and
        // only here. Never cached, never stored by an intermediary.
        set.headers["cache-control"] = "no-store";

        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "totp_enroll_begin",
          rl.totpEnrollBegin,
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
          const stepUpToken = body?.step_up_token ?? headerToken;
          if (!stepUpToken) {
            set.status = 403;
            return { error: "step_up_required" };
          }
          return await run(auth.beginTotpEnrollment(profile.accountId, stepUpToken));
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      },
      {
        body: t.Optional(t.Object({ step_up_token: t.Optional(t.String()) })),
        response: {
          // The field names match the logger redaction deny-list entries
          // (`totpSecret`, `otpauthUri`) — renaming either here silently
          // un-redacts the shared secret in operator logs.
          200: t.Object({ otpauthUri: t.String(), totpSecret: t.String() }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          500: errorResponse,
        },
        detail: { operationId: "beginTotpEnrollment", security: [{ bearerAuth: [] }] },
      },
    )
    .post(
      "/totp/enroll/complete",
      async ({ body, headers, set, server, request }) => {
        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "totp_enroll_complete",
          rl.totpEnrollComplete,
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
          // No step-up gate here, deliberately: `begin` carried it, and the
          // pending secret this verifies against exists only because a gated
          // `begin` created it.
          return await run(
            auth.completeTotpEnrollment(
              profile.accountId,
              body.code,
              body.label?.trim() || null,
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
        body: t.Object({
          code: t.String(),
          label: t.Optional(t.String({ maxLength: 64 })),
        }),
        response: {
          200: t.Object({ enrolled: t.Boolean() }),
          400: errorResponse,
          401: errorResponse,
          429: errorResponse,
          500: errorResponse,
        },
        detail: { operationId: "completeTotpEnrollment", security: [{ bearerAuth: [] }] },
      },
    )
    .delete(
      "/totp",
      async ({ body, headers, set, server, request }) => {
        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "totp_disable",
          rl.totpDisable,
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
          const stepUpToken = body?.step_up_token ?? headerToken;
          if (!stepUpToken) {
            set.status = 403;
            return { error: "step_up_required" };
          }
          return await run(
            auth.disableTotp(
              profile.accountId,
              stepUpToken,
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
        body: t.Optional(t.Object({ step_up_token: t.Optional(t.String()) })),
        response: {
          200: t.Object({ disabled: t.Boolean() }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          500: errorResponse,
        },
        detail: { operationId: "disableTotp", security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/totp/status",
      async ({ headers, set, server, request }) => {
        // Account-scoped and it changes the moment a code is used — never let
        // a shared cache hand one account's state to another request. First
        // statement so the 429 and both 401s carry it too.
        set.headers["cache-control"] = "no-store";

        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "totp_status",
          rl.totpStatus,
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
          return await run(auth.getTotpStatus(profile.accountId));
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      },
      {
        response: {
          // Deliberately no ciphertext, no IV, no key version and no
          // `lastUsedStep`: the step is replay state, and publishing it would
          // tell a caller which codes are already spent.
          200: t.Object({
            enrolled: t.Boolean(),
            label: t.Union([t.String(), t.Null()]),
            lastUsedAt: t.Union([t.Number(), t.Null()]),
            createdAt: t.Union([t.Number(), t.Null()]),
          }),
          400: errorResponse,
          401: errorResponse,
          429: errorResponse,
          500: errorResponse,
        },
        detail: { operationId: "getTotpStatus", security: [{ bearerAuth: [] }] },
      },
    );
}
