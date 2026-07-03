import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import type { AuthRouteContext } from "./context";

export function createProfileSwitchRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // Profile switching (P2 — multi-account)
      //
      // S-H1: these endpoints authenticate via Bearer access token (not
      // refresh token in body). The access token's `sub` is `profileId`;
      // we resolve `accountId` via DB lookup.
      // -------------------------------------------------------------------------
      .get("/profiles/list", async ({ headers, set, server, request }) => {
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
      })
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
            const result = await run(auth.switchProfile(profile.accountId, body.profile_id));
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
        },
      )
  );
}
