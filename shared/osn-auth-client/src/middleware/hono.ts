import type { MiddlewareHandler } from "hono";

import type { OsnAuthOptions } from "../options";
import { extractClaims } from "../verify";

export type { OsnAuthOptions } from "../options";

/**
 * Hono middleware that verifies an OSN-issued access token from the
 * Authorization: Bearer header. On success sets `c.var.osnProfileId` to
 * the `sub` claim. On any failure returns 401.
 *
 * Audience is enforced inside the single jwtVerify pass (P-I1) — the
 * audience parameter is mandatory.
 */
export function osnAuth(options: OsnAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header("authorization");
    const claims = await extractClaims(authHeader, options.jwksUrl, {
      testKey: options._testKey,
      audience: options.audience,
      issuer: options.issuer,
    });
    if (!claims) return c.json({ error: "unauthorised" }, 401);

    c.set("osnProfileId", claims.profileId);
    await next();
  };
}
