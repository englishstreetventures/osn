import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { buildSessionCookies } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";
import { errorResponse, publicProfile, tokenResponse } from "./response-schemas";

export function createRecoveryRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, sessionMetaFrom, rl, cookieConfig } = ctx;
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
          // never cached or stored (tracker#467).
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
            // S-L2: wire field is `recoveryCodes` (not `codes`) so the
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
            // The only time the plaintext codes ever cross the wire. S-L2:
            // the field is `recoveryCodes` so the log redaction deny-list
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
          // First statement so the 429 and both 401s carry it too (tracker#469).
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
  );
}
