import { LOCAL_TEST_ISSUER } from "@shared/crypto/testing";

/**
 * The token-verification config the route suites hand their factories.
 *
 * A literal, deliberately — not `DEFAULT_VERIFICATION` from `src/lib/jwks.ts`,
 * whose issuer is `process.env.OSN_ISSUER_URL` read at module load. Under
 * `dev-env` that variable is exported, so importing the production default
 * would make these suites expect the portless issuer while
 * `makeAccessTokenSigner` stamps the local one: every authenticated test 401s,
 * and the ones asserting 401 pass for entirely the wrong reason. A test that
 * cannot fail is worse than no test when the rejection path is the point.
 *
 * `jwksUrl` is empty because every suite injects a verifying key and never
 * fetches. The issuer is the half that matters, and it matches what the shared
 * signer mints by default.
 */
export const TEST_VERIFICATION = {
  jwksUrl: "",
  issuer: LOCAL_TEST_ISSUER,
} as const;
