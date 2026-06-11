import { Elysia } from "elysia";

import type { OsnAuthOptions } from "../options";
import { extractClaims } from "../verify";

export type { OsnAuthOptions } from "../options";

/** Derive result for requests that fail verification — handler never runs. */
const unauthenticated = { osnProfileId: undefined as string | undefined };

/**
 * Elysia plugin that verifies an OSN-issued access token from the
 * Authorization: Bearer header. On success derives `osnProfileId` (the
 * `sub` claim) onto the request context. On any failure — missing header,
 * bad signature, expired token, wrong audience — responds 401.
 *
 * Audience is enforced inside the single jwtVerify pass (P-I1) — the
 * audience parameter is mandatory.
 */
export function osnAuth(options: OsnAuthOptions) {
  return (
    new Elysia({ name: "osn-auth-client" })
      // Elysia 1.4 named plugins default hooks to "local" scope — without
      // { as: "scoped" } the derive/onBeforeHandle never run in the parent
      // app and every request silently passes unauthenticated.
      .derive({ as: "scoped" }, async ({ headers }) => {
        const claims = await extractClaims(headers.authorization, options.jwksUrl, {
          testKey: options._testKey,
          audience: options.audience,
        });
        if (!claims) return unauthenticated;
        return { osnProfileId: claims.profileId as string | undefined };
      })
      .onBeforeHandle({ as: "scoped" }, ({ osnProfileId, set }) => {
        if (!osnProfileId) {
          set.status = 401;
          return { error: "unauthorised" };
        }
      })
  );
}
