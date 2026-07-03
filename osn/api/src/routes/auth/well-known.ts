import { Elysia } from "elysia";

import { metricAuthJwksServed } from "../../metrics";
import type { AuthRouteContext } from "./context";

export function createWellKnownRoutes(ctx: AuthRouteContext) {
  const { authConfig, jwksResponse } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // OIDC discovery (minimal)
      // -------------------------------------------------------------------------
      .get("/.well-known/openid-configuration", () => ({
        issuer: authConfig.issuerUrl,
        token_endpoint: `${authConfig.issuerUrl}/token`,
        jwks_uri: `${authConfig.issuerUrl}/.well-known/jwks.json`,
        grant_types_supported: ["refresh_token"],
        scopes_supported: ["openid", "profile", "email"],
        id_token_signing_alg_values_supported: ["ES256"],
      }))
      .get("/.well-known/jwks.json", ({ set }) => {
        // S-H1: explicit caching contract — aligns with pulse-side JWKS_CACHE_TTL_MS (5 min).
        set.headers["cache-control"] = "public, max-age=300, stale-while-revalidate=60";
        metricAuthJwksServed();
        return jwksResponse;
      })
  );
}
