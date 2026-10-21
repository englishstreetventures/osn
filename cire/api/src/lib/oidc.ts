import type { OidcConfig } from "@shared/osn-auth-client/oidc-rp";

/**
 * The HKDF `info` cire derives its OIDC transaction-cookie MAC key under.
 *
 * Per-product by design: two relying parties that ever end up sharing an OSN
 * client secret must not be able to verify each other's transaction cookies, or
 * one product's planted transaction could fixate a sign-in at the other. One
 * constant, imported by the runtime config and the test helper alike, so the
 * two cannot drift.
 *
 * Changing this value invalidates only in-flight transactions — a ten-minute
 * TTL — so a bump costs at most one retried sign-in.
 */
export const CIRE_OIDC_TX_HMAC_INFO = "cire-oidc-tx-hmac-v1";

/** The env vars the organiser sign-in config is built from, by name. */
export interface CireOidcEnv {
  /** Issuer origin, e.g. `https://id.musubi.social`; must equal the ID token's `iss`. */
  OSN_ISSUER_URL?: string | undefined;
  /** JWKS endpoint of that issuer, for the ID token's signature. */
  OSN_JWKS_URL?: string | undefined;
  /** cire-api's own public origin; the registered redirect URI is built on it. */
  CIRE_API_ORIGIN?: string | undefined;
  CIRE_OIDC_CLIENT_ID?: string | undefined;
  CIRE_OIDC_CLIENT_SECRET?: string | undefined;
}

/**
 * The organiser sign-in config, or `null`. Both entries build it here: the
 * Worker (`index.ts`) from its bindings and the Bun server (`local.ts`) from
 * `process.env`.
 *
 * All five values or none: a half-configured client cannot complete a single
 * exchange, so `null`, which makes `/api/auth/oidc/*` send the browser to the
 * login page with `sign_in_unavailable`, is the honest state rather than a
 * sign-in that starts and dies at the token endpoint. A trailing slash on the
 * issuer or the API origin is dropped, because the issuer must equal the ID
 * token's `iss` and the redirect URI the registered one, both byte for byte.
 *
 * `allowedReturnOrigins` is the tier's `WEB_ORIGIN` list, the same one CORS
 * echoes, so a `return_to` can only point at a site this tier serves.
 */
export function oidcConfigFromEnv(
  env: CireOidcEnv,
  allowedReturnOrigins: readonly string[],
): OidcConfig | null {
  const issuer = env.OSN_ISSUER_URL?.replace(/\/+$/, "");
  const apiOrigin = env.CIRE_API_ORIGIN?.replace(/\/+$/, "");
  const jwksUrl = env.OSN_JWKS_URL;
  const clientId = env.CIRE_OIDC_CLIENT_ID;
  const clientSecret = env.CIRE_OIDC_CLIENT_SECRET;
  if (!issuer || !apiOrigin || !jwksUrl || !clientId || !clientSecret) return null;
  return {
    issuer,
    jwksUrl,
    clientId,
    clientSecret,
    redirectUri: `${apiOrigin}/api/auth/oidc/callback`,
    allowedReturnOrigins,
    txHmacInfo: CIRE_OIDC_TX_HMAC_INFO,
  };
}
