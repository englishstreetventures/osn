import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { readSessionCookie } from "../../lib/cookie-session";
import type { AuthRouteContext } from "./context";

export function createPasskeyManagementRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, sessionMetaFrom, rl, cookieConfig } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Passkey management (M-PK)
      //
      // GET    /passkeys       — list the caller's credentials (public shape)
      // PATCH  /passkeys/:id   — rename (label only; step-up NOT required)
      // DELETE /passkeys/:id   — remove, revokes other sessions, requires
      //                          step-up (passkey or OTP amr) so an XSS that
      //                          captured an access token cannot drop the
      //                          account's real authenticators.
      // -------------------------------------------------------------------------
      .get("/passkeys", async ({ headers, set, server, request }) => {
        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "passkey_list",
          rl.passkeyList,
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
          return await run(auth.listPasskeys(profile.accountId));
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      .patch(
        "/passkeys/:id",
        async ({ params, body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "passkey_rename",
            rl.passkeyRename,
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
            // S-M2: rename is gated by step-up too. Otherwise an XSS-captured
            // access token could swap labels to mislead the user about which
            // credential they're confirming a delete on. Same AMR set as
            // delete (defaults to passkey-only via passkeyDeleteAllowedAmr).
            const headerToken = headers["x-step-up-token"];
            const stepUpToken = body.step_up_token ?? headerToken;
            if (!stepUpToken) {
              set.status = 403;
              return { error: "step_up_required" };
            }
            await run(auth.verifyStepUpForPasskeyDelete(profile.accountId, stepUpToken));
            await run(auth.renamePasskey(profile.accountId, params.id, body.label));
            return { success: true };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ id: t.String({ pattern: "^pk_[a-f0-9]{12}$" }) }),
          body: t.Object({ label: t.String(), step_up_token: t.Optional(t.String()) }),
        },
      )
      .delete(
        "/passkeys/:id",
        async ({ params, body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "passkey_delete",
            rl.passkeyDelete,
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
            // S-L4: passkey-delete uses its own AMR set (defaults to
            // passkey-only). The caller necessarily has a passkey by
            // construction (last-passkey guard), so requiring one for
            // deletion is the strongest available signal.
            await run(auth.verifyStepUpForPasskeyDelete(profile.accountId, stepUpToken));
            const cookieToken = readSessionCookie(headers.cookie, cookieConfig);
            const currentHash = cookieToken ? auth.hashSessionToken(cookieToken) : null;
            const result = await run(
              auth.deletePasskey(
                profile.accountId,
                params.id,
                currentHash,
                sessionMetaFrom(headers, socketIpOf({ server, request })),
              ),
            );
            return { success: true, remaining: result.remaining };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ id: t.String({ pattern: "^pk_[a-f0-9]{12}$" }) }),
          body: t.Optional(t.Object({ step_up_token: t.Optional(t.String()) })),
        },
      )
  );
}
