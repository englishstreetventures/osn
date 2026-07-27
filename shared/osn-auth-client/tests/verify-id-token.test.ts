import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearJwksCache } from "../src/jwks-cache";
import { verifyIdToken } from "../src/verify-id-token";

const JWKS_URL = "http://test/.well-known/jwks.json";
const ISSUER = "https://id.musubi.social";
const AUDIENCE = "cire";

describe("verifyIdToken", () => {
  let signKey: CryptoKey;
  let verifyKey: CryptoKey;
  let otherSignKey: CryptoKey;
  const kid = "test-kid-1";

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signKey = pair.privateKey;
    verifyKey = pair.publicKey;
    otherSignKey = (await generateKeyPair("ES256")).privateKey;

    const jwk = await exportJWK(verifyKey);
    const keys = [{ ...jwk, kid, alg: "ES256", use: "sig" }];
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      input: Parameters<typeof fetch>[0],
    ) => {
      if (String(input).endsWith("/.well-known/jwks.json")) {
        return new Response(JSON.stringify({ keys }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${input}`);
    }) as typeof fetch;
  });

  beforeEach(() => {
    clearJwksCache();
  });

  const mint = async (
    claims: Record<string, unknown>,
    overrides: { key?: CryptoKey; issuer?: string; audience?: string; expired?: boolean } = {},
  ) => {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("pw_abc123")
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setIssuedAt();
    // Well outside the ±30s clock tolerance.
    return jwt.setExpirationTime(overrides.expired ? "-10m" : "5m").sign(overrides.key ?? signKey);
  };

  const opts = (extra: Record<string, unknown> = {}) => ({
    issuer: ISSUER,
    audience: AUDIENCE,
    testKey: verifyKey,
    ...extra,
  });

  it("returns the pairwise sub and the first-party profile id", async () => {
    const token = await mint({
      nonce: "n-1",
      osn_profile_id: "usr_alice",
      preferred_username: "alice",
      name: "Alice",
      picture: "https://cdn.example.com/a.png",
      email: "alice@example.com",
      auth_time: 1_700_000_000,
    });

    const claims = await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-1" }));

    expect(claims).toEqual({
      sub: "pw_abc123",
      osnProfileId: "usr_alice",
      email: "alice@example.com",
      handle: "alice",
      displayName: "Alice",
      avatarUrl: "https://cdn.example.com/a.png",
      authTime: 1_700_000_000,
    });
  });

  it("reports a missing osn_profile_id as null rather than falling back to sub", async () => {
    const token = await mint({ nonce: "n-1" });

    const claims = await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-1" }));

    expect(claims?.sub).toBe("pw_abc123");
    expect(claims?.osnProfileId).toBeNull();
  });

  it("rejects a mismatched nonce", async () => {
    const token = await mint({ nonce: "n-1" });

    expect(await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-2" }))).toBeNull();
  });

  it("rejects a missing nonce when one was sent", async () => {
    const token = await mint({});

    expect(await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-1" }))).toBeNull();
  });

  it("rejects a token minted for another client", async () => {
    const token = await mint({ nonce: "n-1" }, { audience: "someone-else" });

    expect(await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-1" }))).toBeNull();
  });

  it("rejects a token from another issuer", async () => {
    const token = await mint({ nonce: "n-1" }, { issuer: "https://evil.example.com" });

    expect(await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-1" }))).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await mint({ nonce: "n-1" }, { expired: true });

    expect(await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-1" }))).toBeNull();
  });

  it("rejects a signature from an unknown key", async () => {
    const token = await mint({ nonce: "n-1" }, { key: otherSignKey });

    expect(await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-1" }))).toBeNull();
  });

  it("rejects a non-ES256 header", async () => {
    const token = await new SignJWT({ nonce: "n-1" })
      .setProtectedHeader({ alg: "HS256", kid })
      .setSubject("pw_abc123")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new Uint8Array(32));

    expect(await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-1" }))).toBeNull();
  });

  it("rejects a token with no kid", async () => {
    const token = await new SignJWT({ nonce: "n-1" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("pw_abc123")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    expect(await verifyIdToken(token, JWKS_URL, opts({ nonce: "n-1" }))).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyIdToken("not-a-jwt", JWKS_URL, opts({ nonce: "n-1" }))).toBeNull();
  });

  it("verifies through the JWKS fetch when no test key is given", async () => {
    const token = await mint({ nonce: "n-1", osn_profile_id: "usr_alice" });

    const claims = await verifyIdToken(token, JWKS_URL, {
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: "n-1",
    });

    expect(claims?.osnProfileId).toBe("usr_alice");
  });
});
