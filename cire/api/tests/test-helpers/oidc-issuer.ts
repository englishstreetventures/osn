import {
  TEST_TX_HMAC_INFO,
  makeOidcTestIssuer as makeSharedOidcTestIssuer,
} from "@shared/osn-auth-client/testing/oidc-issuer";

/**
 * Cire's view of the shared fake OSN issuer.
 *
 * The issuer itself lives in `@shared/osn-auth-client/testing/oidc-issuer`, so
 * every product signing in through the shared relying party tests against the
 * same issuer behaviour. Only two things are cire's: the return origin (which
 * must match `createApp`'s default `webOrigin`, so route tests need no
 * override) and the paths built on it.
 *
 * Sibling of `test-helpers/osn-token.ts`, which mints ACCESS tokens
 * (`aud: "osn-access"`, `sub` = the real profile id). These are ID tokens:
 * `aud` is the client id and `sub` is the pairwise subject, with the profile id
 * in the first-party `osn_profile_id` claim.
 */

export {
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_ISSUER,
  TEST_PAIRWISE_SUB,
  TEST_PROFILE_ID,
  TEST_REDIRECT_URI,
  stubTokenEndpoint,
  tokenResponse,
} from "@shared/osn-auth-client/testing/oidc-issuer";
export type {
  IdTokenOverrides,
  OidcTestIssuer,
  TokenEndpointCall,
  TokenEndpointStub,
} from "@shared/osn-auth-client/testing/oidc-issuer";

/** Matches `createApp`'s default `webOrigin`, so route tests need no override. */
export const TEST_RETURN_ORIGIN = "http://localhost:4321";
export const TEST_RETURN_TO = `${TEST_RETURN_ORIGIN}/weddings`;

/**
 * The shared issuer, with its allowlist pointed at cire's dev origin. Test
 * files import this rather than the shared factory so the origin is set once.
 *
 * `txHmacInfo` comes from the shared helper's `TEST_TX_HMAC_INFO`, not cire's
 * production `CIRE_OIDC_TX_HMAC_INFO` — the tests exercise the mechanism, and
 * pinning them to the production value would make a future bump of it a test
 * churn for no gain.
 */
export function makeOidcTestIssuer() {
  return makeSharedOidcTestIssuer({ returnOrigin: TEST_RETURN_ORIGIN });
}

export { TEST_TX_HMAC_INFO };
