import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { buildSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";

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
      // POST /login/recovery/complete — unauthenticated. Exchanges an identifier
      //                            + recovery code for a full session + profile,
      //                            and revokes all other sessions for the account.
      // -------------------------------------------------------------------------
      .post(
        "/recovery/generate",
        async ({ body, headers, set, server, request }) => {
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
            set.headers["set-cookie"] = buildSessionCookie(
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
        },
      )
  );
}
