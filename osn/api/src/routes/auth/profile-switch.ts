import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import type { AuthRouteContext } from "./context";
import { errorResponse, publicProfile } from "./response-schemas";

export function createProfileSwitchRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Profile switching (P2 — multi-account)
      //
      // These endpoints authenticate via Bearer access token (not
      // refresh token in body). The access token's `sub` is `profileId`;
      // we resolve `accountId` via DB lookup.
      // -------------------------------------------------------------------------
      .get(
        "/profiles/list",
        async ({ headers, set, server, request }) => {
          // Per-user profile list — never cached or stored.
          set.headers["cache-control"] = "private, no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "profile_list",
            rl.profileList,
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
            return await run(auth.listAccountProfiles(profile.accountId));
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            200: t.Object({ profiles: t.Array(publicProfile) }),
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "listAccountProfiles", security: [{ bearerAuth: [] }] },
        },
      )
      .post(
        "/profiles/switch",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "profile_switch",
            rl.profileSwitch,
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
            // A switch mints an access token, so the caller must hold a live,
            // ordinary session, named by its cookie or its token's `osn_sid`
            // binding; checked before the per-account switch cap is spent.
            // The new token is bound to that session under the new profile.
            const live = await ctx.liveSession(
              "profile_switch",
              profile.accountId,
              claims,
              headers.cookie,
            );
            if (live.sessionHash === null) {
              set.status = 409;
              return live.refusal;
            }
            const result = await run(
              auth.switchProfile(profile.accountId, body.profile_id, live.sessionHash),
            );
            return {
              access_token: result.accessToken,
              expires_in: result.expiresIn,
              profile: result.profile,
            };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            profile_id: t.String({ pattern: "^usr_[a-f0-9]{12}$" }),
          }),
          response: {
            // No `token_type`/`scope` here — a switch re-issues only the
            // access token; the session (and its cookie) is unchanged.
            200: t.Object({
              access_token: t.String(),
              expires_in: t.Number(),
              profile: publicProfile,
            }),
            400: errorResponse,
            401: errorResponse,
            // `session_stale`: the access token's session has ended.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "switchProfile", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
