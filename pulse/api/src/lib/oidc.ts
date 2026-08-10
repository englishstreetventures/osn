import type { OidcConfig } from "@shared/osn-auth-client/oidc-rp";

/**
 * The HKDF `info` Pulse derives its OIDC transaction-cookie MAC key under.
 *
 * Per-product by design: two relying parties that ever end up sharing an OSN
 * client secret must not be able to verify each other's transaction cookies, or
 * a transaction planted at one product could fixate a sign-in at the other. One
 * constant, imported by the runtime config and the test helper alike, so the
 * two cannot drift.
 *
 * Changing this value invalidates only in-flight transactions — a ten-minute
 * TTL — so a bump costs at most one retried sign-in.
 */
export const PULSE_OIDC_TX_HMAC_INFO = "pulse-oidc-tx-hmac-v1";

/** The env pieces the relying-party config is assembled from. */
export interface PulseOidcEnv {
  /** Issuer origin, e.g. `https://id.musubi.social`. */
  OSN_ISSUER_URL?: string | undefined;
  /** JWKS endpoint of that issuer. */
  OSN_JWKS_URL?: string | undefined;
  /** Public origin of pulse-api itself — the registered redirect URI's host. */
  PULSE_API_ORIGIN?: string | undefined;
  OSN_OIDC_CLIENT_ID?: string | undefined;
  OSN_OIDC_CLIENT_SECRET?: string | undefined;
}

/**
 * Assemble the relying-party config, or `null`.
 *
 * All five pieces or none: a half-configured client cannot complete a single
 * exchange, so `null` — which makes the sign-in routes answer with the
 * `sign_in_unavailable` marker — is the honest state rather than a flow that
 * starts and then dies at the token endpoint. Callers log the incomplete case
 * on deployed tiers; locally `bun run dev:pulse` runs without an issuer.
 *
 * `allowedReturnOrigins` is the CORS allowlist, so a `return_to` can only point
 * at an origin this tier already serves.
 */
export function buildPulseOidcConfig(
  env: PulseOidcEnv,
  allowedReturnOrigins: readonly string[],
): OidcConfig | null {
  const issuer = env.OSN_ISSUER_URL?.replace(/\/+$/, "");
  const apiOrigin = env.PULSE_API_ORIGIN?.replace(/\/+$/, "");
  const jwksUrl = env.OSN_JWKS_URL;
  const clientId = env.OSN_OIDC_CLIENT_ID;
  const clientSecret = env.OSN_OIDC_CLIENT_SECRET;
  if (!issuer || !apiOrigin || !jwksUrl || !clientId || !clientSecret) return null;
  return {
    issuer,
    jwksUrl,
    clientId,
    clientSecret,
    redirectUri: `${apiOrigin}/api/auth/oidc/callback`,
    allowedReturnOrigins,
    txHmacInfo: PULSE_OIDC_TX_HMAC_INFO,
  };
}
