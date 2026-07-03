import { Elysia, t } from "elysia";

import { buildSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";
import { toTokenResponseCookieOnly } from "./context";

export function createPasskeyLoginRoutes(ctx: AuthRouteContext) {
  const { auth, run, rateLimit, turnstileGate, socketIpOf, sessionMetaFrom, rl, cookieConfig } =
    ctx;
  return (
    new Elysia()
      // =========================================================================
      // First-party direct-session login endpoints
      //
      // Passkey (and security key) is the only primary login factor. The
      // `/login/recovery/complete` endpoint lower in this file is the
      // "lost your device" escape hatch — it issues a session directly
      // from a recovery code + identifier. OTP and magic link remain
      // only as step-up and email-change factors, never as a primary
      // login.
      // =========================================================================
      .post(
        "/login/passkey/begin",
        async ({ body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "passkey_login_begin",
            rl.passkeyLoginBegin,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          // Turnstile bot gate (key-optional; no-op when the secret is unset).
          // ONLY the interactive, identifier-bound form carries a token and is
          // gated. The silent conditional-UI / discoverable-credential ceremony
          // (no identifier) runs token-free BY DESIGN — the frontend renders no
          // challenge for it — so gating it would fail-closed and break passkey
          // autofill sign-in (the common path). It discloses nothing
          // account-specific, still requires a valid passkey assertion to
          // complete, and remains per-IP rate-limited above.
          const identifierPresent =
            typeof body.identifier === "string" && body.identifier.trim() !== "";
          if (identifierPresent) {
            const tsErr = await turnstileGate("passkey_login_begin", body.turnstileToken, headers);
            if (tsErr) {
              set.status = 400;
              return tsErr;
            }
          }
          try {
            // M-PK: identifier is optional. Omitting it kicks off the
            // discoverable-credential / conditional-UI flow and the
            // response carries a `challengeId` the client must round-trip
            // to /login/passkey/complete.
            const result = await run(auth.beginPasskeyLogin(body.identifier ?? null));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({
            identifier: t.Optional(t.String()),
            // Turnstile widget token (see /register/begin). Optional in the
            // schema; enforced by `turnstileGate` only when configured.
            turnstileToken: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/login/passkey/complete",
        async ({ body, set, headers, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "passkey_login_complete",
            rl.passkeyLoginComplete,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          // Exactly one of identifier / challengeId must be present.
          const hasIdentifier = typeof body.identifier === "string" && body.identifier.length > 0;
          const hasChallengeId =
            typeof body.challengeId === "string" && body.challengeId.length > 0;
          if (hasIdentifier === hasChallengeId) {
            set.status = 400;
            return { error: "invalid_request" };
          }
          try {
            const result = await run(
              auth.completePasskeyLoginDirect(
                hasIdentifier
                  ? { identifier: body.identifier!, assertion: body.assertion }
                  : { challengeId: body.challengeId!, assertion: body.assertion },
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
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({
            identifier: t.Optional(t.String()),
            challengeId: t.Optional(t.String()),
            assertion: t.Any(),
          }),
        },
      )
  );
}
