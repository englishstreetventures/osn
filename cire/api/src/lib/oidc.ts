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
