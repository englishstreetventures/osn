import { describe, expect, it } from "bun:test";

import { CIRE_OIDC_TX_HMAC_INFO, oidcConfigFromEnv, type CireOidcEnv } from "../../src/lib/oidc";

const COMPLETE: Required<CireOidcEnv> = {
  OSN_ISSUER_URL: "https://id.musubi.social",
  OSN_JWKS_URL: "https://id.musubi.social/.well-known/jwks.json",
  CIRE_API_ORIGIN: "https://api.cireweddings.com",
  CIRE_OIDC_CLIENT_ID: "cid_cire",
  CIRE_OIDC_CLIENT_SECRET: "not-a-real-secret",
};

const ORIGINS = ["https://invite.cireweddings.com", "https://host.cireweddings.com"];

describe("oidcConfigFromEnv", () => {
  it("builds no config when any one of the five values is missing or empty", () => {
    // A half-configured client cannot finish one exchange: the sign-in routes
    // must answer `sign_in_unavailable` rather than send an organiser to the
    // issuer and fail at the token endpoint.
    for (const name of Object.keys(COMPLETE) as Array<keyof CireOidcEnv>) {
      const { [name]: _dropped, ...missing } = COMPLETE;
      expect(oidcConfigFromEnv(missing, ORIGINS)).toBeNull();
      expect(oidcConfigFromEnv({ ...COMPLETE, [name]: "" }, ORIGINS)).toBeNull();
    }
  });

  it("drops a trailing slash so the issuer and the redirect URI match byte for byte", () => {
    // The issuer must equal the ID token's `iss`, and the redirect URI the one
    // registered with osn-api; a slash typed at the end of either var breaks both.
    const config = oidcConfigFromEnv(
      {
        ...COMPLETE,
        OSN_ISSUER_URL: "https://id.musubi.social/",
        CIRE_API_ORIGIN: "https://api.cireweddings.com//",
      },
      ORIGINS,
    );
    expect(config?.issuer).toBe("https://id.musubi.social");
    expect(config?.redirectUri).toBe("https://api.cireweddings.com/api/auth/oidc/callback");
  });

  it("allows a return only to the origins it is given, and keys its cookie MAC to cire", () => {
    // Any origin beyond the tier's own list would make `return_to` an open
    // redirect, and another product's HKDF info would let its transaction
    // cookie verify here.
    const config = oidcConfigFromEnv(COMPLETE, ORIGINS);
    expect(config).toEqual({
      issuer: "https://id.musubi.social",
      jwksUrl: "https://id.musubi.social/.well-known/jwks.json",
      clientId: "cid_cire",
      clientSecret: "not-a-real-secret",
      redirectUri: "https://api.cireweddings.com/api/auth/oidc/callback",
      allowedReturnOrigins: ORIGINS,
      txHmacInfo: "cire-oidc-tx-hmac-v1",
    });
    expect(config?.txHmacInfo).toBe(CIRE_OIDC_TX_HMAC_INFO);
  });
});
