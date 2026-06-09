import type { MiddlewareHandler } from "hono";
import { decodeJwt } from "jose";

import { extractClaims } from "../verify";

export interface OsnAuthOptions {
  /** Full JWKS URL — e.g. `https://osn-api.example.com/.well-known/jwks.json` */
  jwksUrl: string;
  /** Expected `aud` claim — typically `"osn-access"` */
  audience: string;
  /** Optional injected verifying key for tests (skips JWKS fetch). */
  _testKey?: CryptoKey;
}

/**
 * Hono middleware that verifies an OSN-issued access token from the
 * Authorization: Bearer header. On success sets `c.var.osnProfileId` to
 * the `sub` claim. On any failure returns 401.
 *
 * Audience checking happens here (extractClaims doesn't enforce aud);
 * the audience parameter is mandatory.
 */
export function osnAuth(options: OsnAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header("authorization");
    const claims = await extractClaims(authHeader, options.jwksUrl, options._testKey);
    if (!claims) return c.json({ error: "unauthorised" }, 401);

    const token = authHeader?.slice("Bearer ".length);
    if (!token) return c.json({ error: "unauthorised" }, 401);
    try {
      const payload = decodeJwt(token);
      const aud = payload.aud;
      const matches =
        typeof aud === "string"
          ? aud === options.audience
          : Array.isArray(aud) && aud.includes(options.audience);
      if (!matches) return c.json({ error: "unauthorised" }, 401);
    } catch {
      return c.json({ error: "unauthorised" }, 401);
    }

    c.set("osnProfileId", claims.profileId);
    await next();
  };
}
