import { Elysia } from "elysia";

import { metricAuthJwksServed } from "../../metrics";
import type { AuthRouteContext } from "./context";

export function createWellKnownRoutes(ctx: AuthRouteContext) {
  const { authConfig, jwksResponse } = ctx;
  return (
    new Elysia()
      // -------------------------------------------------------------------------
      // OIDC discovery (OIDC Discovery 1.0 §3).
      //
      // Advertise only what is built. A relying-party library reads this
      // document and calls whatever it lists, so an aspirational entry here
      // turns into a 404 inside somebody else's integration.
      //
      // No `userinfo_endpoint` on purpose: the id_token carries the claims, and
      // a second claims endpoint is a second thing to keep authorized right.
      // `refresh_token` stays in the grant list for the first-party cookie flow
      // at `/token`; relying parties get no refresh token, which is why
      // `offline_access` is absent from the scopes.
      // -------------------------------------------------------------------------
      .get("/.well-known/openid-configuration", () => ({
        issuer: authConfig.issuerUrl,
        authorization_endpoint: `${authConfig.issuerUrl}/authorize`,
        token_endpoint: `${authConfig.issuerUrl}/oidc/token`,
        jwks_uri: `${authConfig.issuerUrl}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        scopes_supported: ["openid", "profile", "email"],
        subject_types_supported: ["pairwise"],
        id_token_signing_alg_values_supported: ["ES256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "name", "email"],
      }))
      .get("/.well-known/jwks.json", ({ set }) => {
        // S-H1: explicit caching contract — aligns with pulse-side JWKS_CACHE_TTL_MS (5 min).
        set.headers["cache-control"] = "public, max-age=300, stale-while-revalidate=60";
        metricAuthJwksServed();
        return jwksResponse;
      })
  );
}
