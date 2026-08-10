import { Elysia, t } from "elysia";

import { metricAuthJwksServed } from "../../metrics";
import type { AuthRouteContext } from "./context";

/** OIDC Discovery 1.0 §3 — every field below is advertised, so every field is built. */
const openidConfiguration = t.Object({
  issuer: t.String(),
  authorization_endpoint: t.String(),
  token_endpoint: t.String(),
  jwks_uri: t.String(),
  response_types_supported: t.Array(t.String()),
  response_modes_supported: t.Array(t.String()),
  grant_types_supported: t.Array(t.String()),
  scopes_supported: t.Array(t.String()),
  subject_types_supported: t.Array(t.String()),
  id_token_signing_alg_values_supported: t.Array(t.String()),
  code_challenge_methods_supported: t.Array(t.String()),
  authorization_response_iss_parameter_supported: t.Boolean(),
  token_endpoint_auth_methods_supported: t.Array(t.String()),
  claims_supported: t.Array(t.String()),
});

/**
 * RFC 7517 JWK Set. `additionalProperties: true` is deliberate: the key
 * object is built by spreading `authConfig.jwtPublicKeyJwk`, and Elysia
 * DELETES undeclared keys from a response before sending it. A JWK field
 * this schema forgot would be silently dropped from the document every
 * relying party verifies signatures against — so the schema documents the
 * ES256 fields and passes the rest through untouched.
 */
const jwkSet = t.Object({
  keys: t.Array(
    t.Object(
      {
        // Optional to match jose's `JWK`, where every member is optional —
        // `exportJWK` always emits `kty`, but the type can't say so.
        kty: t.Optional(t.String()),
        crv: t.Optional(t.String()),
        x: t.Optional(t.String()),
        y: t.Optional(t.String()),
        use: t.String(),
        alg: t.String(),
        kid: t.String(),
        key_ops: t.Array(t.String()),
      },
      { additionalProperties: true },
    ),
  ),
});

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
      .get(
        "/.well-known/openid-configuration",
        () => ({
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
          // RFC 9207: authorization responses carry an `iss` parameter.
          authorization_response_iss_parameter_supported: true,
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
            "none",
          ],
          claims_supported: [
            "sub",
            "iss",
            "aud",
            "exp",
            "iat",
            "auth_time",
            "nonce",
            "name",
            "preferred_username",
            "picture",
            "email",
            "email_verified",
          ],
        }),
        {
          response: { 200: openidConfiguration },
          detail: { operationId: "getOpenIdConfiguration" },
        },
      )
      .get(
        "/.well-known/jwks.json",
        ({ set }) => {
          // S-H1: explicit caching contract — aligns with pulse-side JWKS_CACHE_TTL_MS (5 min).
          set.headers["cache-control"] = "public, max-age=300, stale-while-revalidate=60";
          metricAuthJwksServed();
          return jwksResponse;
        },
        {
          response: { 200: jwkSet },
          detail: { operationId: "getJwks" },
        },
      )
  );
}
