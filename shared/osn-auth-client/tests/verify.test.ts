import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { describe, expect, it, beforeAll, beforeEach } from "vitest";

import { clearJwksCache } from "../src/jwks-cache";
import * as verifyModule from "../src/verify";
import { extractClaims } from "../src/verify";

describe("extractClaims", () => {
  let signKey: CryptoKey;
  let verifyKey: CryptoKey;
  let kid: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signKey = pair.privateKey;
    verifyKey = pair.publicKey;
    kid = "test-kid-1";
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

  it("returns null for missing auth header", async () => {
    const result = await extractClaims(undefined, "http://test/.well-known/jwks.json");
    expect(result).toBeNull();
  });

  it("returns null for non-Bearer auth header", async () => {
    const result = await extractClaims("Basic abc", "http://test/.well-known/jwks.json");
    expect(result).toBeNull();
  });

  it("returns claims for a valid token via _testKey", async () => {
    const token = await new SignJWT({ email: "alice@example.com", handle: "alice" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_alice")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const result = await extractClaims(
      `Bearer ${token}`,
      "http://test/.well-known/jwks.json",
      verifyKey,
    );
    expect(result).toEqual({
      profileId: "usr_alice",
      email: "alice@example.com",
      handle: "alice",
      displayName: null,
    });
  });

  it("returns claims via JWKS fetch", async () => {
    const token = await new SignJWT({ displayName: "Alice" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_alice")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const result = await extractClaims(`Bearer ${token}`, "http://test/.well-known/jwks.json");
    expect(result).not.toBeNull();
    expect(result?.profileId).toBe("usr_alice");
    expect(result?.displayName).toBe("Alice");
  });

  it("returns null for expired token", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_alice")
      .setIssuedAt()
      .setExpirationTime("0s")
      .sign(signKey);

    // wait a tick so the token is actually expired
    await new Promise((r) => setTimeout(r, 10));
    const result = await extractClaims(
      `Bearer ${token}`,
      "http://test/.well-known/jwks.json",
      verifyKey,
    );
    expect(result).toBeNull();
  });

  it("does not export DEFAULT_JWKS_URL (env reads stay app-side)", () => {
    expect("DEFAULT_JWKS_URL" in verifyModule).toBe(false);
  });
});
