import { SignJWT, generateKeyPair } from "jose";

import type { OidcConfig } from "../services/oidc-login";

/**
 * A fake OSN issuer for the OIDC relying-party tests.
 *
 * Two seams stand in for the network: `_testKey` on the config replaces the
 * JWKS fetch, and `_fetch` replaces the back-channel token exchange. Nothing
 * here touches a socket.
 *
 * Sibling of `test-helpers/osn-token.ts`, which mints ACCESS tokens
 * (`aud: "osn-access"`, `sub` = the real profile id). These are ID tokens:
 * `aud` is the client id and `sub` is the pairwise subject, with the profile id
 * in the first-party `osn_profile_id` claim.
 */

export const TEST_ISSUER = "https://id.test.invalid";
export const TEST_CLIENT_ID = "cid_test";
export const TEST_CLIENT_SECRET = "shh-test-secret";
export const TEST_REDIRECT_URI = "https://api.test.invalid/api/auth/oidc/callback";
/** Matches `createApp`'s default `webOrigin`, so route tests need no override. */
export const TEST_RETURN_ORIGIN = "http://localhost:4321";
export const TEST_RETURN_TO = `${TEST_RETURN_ORIGIN}/weddings`;
export const TEST_PROFILE_ID = "usr_test_organiser";
export const TEST_PAIRWISE_SUB = "pw_test_pairwise_subject";

export interface IdTokenOverrides {
  /** Pairwise subject. */
  sub?: string;
  /** First-party profile-id claim; `null` omits it entirely. */
  osnProfileId?: string | null;
  /** Replay binding — the test must pass the `nonce` its own tx carries. */
  nonce?: string;
  email?: string | null;
  handle?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  authTime?: number;
  issuer?: string;
  audience?: string;
  /** jose duration string; negative values mint an already-expired token. */
  expiresIn?: string;
}

export interface OidcTestIssuer {
  /** Public verifying key — goes on the config as `_testKey`. */
  publicKey: CryptoKey;
  /** Mints an ES256 ID token. Every field has a working default. */
  signIdToken(overrides?: IdTokenOverrides): Promise<string>;
  /** RP config for this issuer. Pass `_fetch` per test. */
  config(overrides?: Partial<OidcConfig>): OidcConfig;
}

export async function makeOidcTestIssuer(): Promise<OidcTestIssuer> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");

  return {
    publicKey,

    signIdToken(overrides: IdTokenOverrides = {}): Promise<string> {
      const claims: Record<string, unknown> = {
        email: overrides.email === undefined ? "organiser@example.test" : overrides.email,
        preferred_username: overrides.handle === undefined ? "organiser" : overrides.handle,
        name: overrides.displayName === undefined ? "Test Organiser" : overrides.displayName,
        picture:
          overrides.avatarUrl === undefined
            ? "https://cdn.test.invalid/a.png"
            : overrides.avatarUrl,
      };
      // `null` means "issuer did not treat us as first-party" — omit the claim
      // rather than sending a null, which is what a real non-first-party token
      // looks like.
      const profileId =
        overrides.osnProfileId === undefined ? TEST_PROFILE_ID : overrides.osnProfileId;
      if (profileId !== null) claims["osn_profile_id"] = profileId;
      if (overrides.nonce !== undefined) claims["nonce"] = overrides.nonce;
      if (overrides.authTime !== undefined) claims["auth_time"] = overrides.authTime;

      return new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: "test-oidc-kid" })
        .setSubject(overrides.sub ?? TEST_PAIRWISE_SUB)
        .setIssuer(overrides.issuer ?? TEST_ISSUER)
        .setAudience(overrides.audience ?? TEST_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime(overrides.expiresIn ?? "5m")
        .sign(privateKey);
    },

    config(overrides: Partial<OidcConfig> = {}): OidcConfig {
      return {
        issuer: TEST_ISSUER,
        jwksUrl: `${TEST_ISSUER}/.well-known/jwks.json`,
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        redirectUri: TEST_REDIRECT_URI,
        allowedReturnOrigins: [TEST_RETURN_ORIGIN],
        _testKey: publicKey,
        ...overrides,
      };
    },
  };
}

export interface TokenEndpointCall {
  url: string;
  /** The form body — the exchange is `client_secret_post`, never Basic. */
  params: URLSearchParams;
  headers: Headers;
}

export interface TokenEndpointStub {
  /** Drop-in for `OidcConfig._fetch`. */
  fetch: typeof fetch;
  /** Every exchange the RP attempted, in order. */
  calls: TokenEndpointCall[];
}

/** Records each token-endpoint POST and answers with whatever `respond` returns. */
export function stubTokenEndpoint(
  respond: (call: TokenEndpointCall) => Response | Promise<Response>,
): TokenEndpointStub {
  const calls: TokenEndpointCall[] = [];
  const doFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = init?.body;
    const params = new URLSearchParams(
      body instanceof URLSearchParams ? body.toString() : String(body ?? ""),
    );
    const call: TokenEndpointCall = { url, params, headers: new Headers(init?.headers) };
    calls.push(call);
    return respond(call);
  };
  return { fetch: doFetch as unknown as typeof fetch, calls };
}

/** The shape a healthy token endpoint returns. */
export function tokenResponse(idToken: string): Response {
  return new Response(
    JSON.stringify({ id_token: idToken, access_token: "at_ignored", token_type: "Bearer" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
