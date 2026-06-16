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

    const result = await extractClaims(`Bearer ${token}`, "http://test/.well-known/jwks.json", {
      testKey: verifyKey,
    });
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
    // Expire well outside the 30s clockTolerance (X2) so the token is
    // unambiguously expired rather than merely within the skew window.
    const past = Math.floor(Date.now() / 1000) - 120;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_alice")
      .setIssuedAt(past - 60)
      .setExpirationTime(past)
      .sign(signKey);

    const result = await extractClaims(`Bearer ${token}`, "http://test/.well-known/jwks.json", {
      testKey: verifyKey,
    });
    expect(result).toBeNull();
  });

  it("does not export DEFAULT_JWKS_URL (env reads stay app-side)", () => {
    expect("DEFAULT_JWKS_URL" in verifyModule).toBe(false);
  });
});

// T-E2: negative/rotation paths. These drive the real JWKS-fetch path (no
// testKey) so we can assert how many upstream fetches each scenario costs —
// pinning the P-C1 amplification fix.
describe("extractClaims — negative + rotation paths", () => {
  const JWKS_URL = "http://issuer/.well-known/jwks.json";

  let keyA: { signKey: CryptoKey; jwk: Record<string, unknown> };
  let keyB: { signKey: CryptoKey; jwk: Record<string, unknown> };
  const kidA = "kid-a";

  /** Current JWKS payload served by the stub; tests mutate this. */
  let servedKeys: Record<string, unknown>[] = [];
  let fetchCount = 0;

  async function makeKey(kid: string) {
    const pair = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" };
    return { signKey: pair.privateKey, jwk };
  }

  beforeAll(async () => {
    keyA = await makeKey(kidA);
    keyB = await makeKey(kidA); // same kid, rotated material
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      _input: Parameters<typeof fetch>[0],
    ) => {
      fetchCount++;
      return new Response(JSON.stringify({ keys: servedKeys }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  beforeEach(() => {
    clearJwksCache();
    fetchCount = 0;
    servedKeys = [keyA.jwk];
  });

  it("rejects a non-ES256 (HS256) token — alg-confusion gate", async () => {
    const secret = new TextEncoder().encode("a".repeat(32));
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: kidA })
      .setSubject("usr_a")
      .setExpirationTime("5m")
      .sign(secret);
    const result = await extractClaims(`Bearer ${token}`, JWKS_URL);
    expect(result).toBeNull();
    expect(fetchCount).toBe(0); // gated before any fetch
  });

  it("rejects a kid-less token", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("usr_a")
      .setExpirationTime("5m")
      .sign(keyA.signKey);
    const result = await extractClaims(`Bearer ${token}`, JWKS_URL);
    expect(result).toBeNull();
    expect(fetchCount).toBe(0);
  });

  it("unknown kid → null with NO forced refresh, repeats hit the negative cache (P-C1)", async () => {
    const junkKidKey = await makeKey("junk-kid");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "junk-kid" })
      .setSubject("usr_a")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(junkKidKey.signKey);

    // First attempt: one resolve fetch, and crucially NOT a second forced
    // refresh (refresh bypasses the negative cache, so falling through to it
    // would re-open the junk-kid amplification hole).
    expect(await extractClaims(`Bearer ${token}`, JWKS_URL)).toBeNull();
    expect(fetchCount).toBe(1);

    // Repeat attempts within NEGATIVE_TTL_MS cost zero upstream fetches.
    expect(await extractClaims(`Bearer ${token}`, JWKS_URL)).toBeNull();
    expect(await extractClaims(`Bearer ${token}`, JWKS_URL)).toBeNull();
    expect(fetchCount).toBe(1);
  });

  it("expired token → null with NO refresh fetch (P-C1)", async () => {
    // Expire outside the 30s clockTolerance (X2) so it's genuinely expired.
    const past = Math.floor(Date.now() / 1000) - 120;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_a")
      .setIssuedAt(past - 60)
      .setExpirationTime(past)
      .sign(keyA.signKey);

    const result = await extractClaims(`Bearer ${token}`, JWKS_URL);
    expect(result).toBeNull();
    // One fetch to resolve the key, and crucially NOT a second forced refresh.
    expect(fetchCount).toBe(1);
  });

  it("wrong-audience token → null with NO refresh fetch", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_a")
      .setAudience("osn-step-up")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keyA.signKey);

    const result = await extractClaims(`Bearer ${token}`, JWKS_URL, { audience: "osn-access" });
    expect(result).toBeNull();
    expect(fetchCount).toBe(1); // resolve only, no rotation retry
  });

  it("key rotation: stale cached key, rotated JWKS on refresh → claims resolve", async () => {
    // Prime the cache with keyA by verifying a keyA-signed token.
    const tokenA = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_a")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keyA.signKey);
    const primed = await extractClaims(`Bearer ${tokenA}`, JWKS_URL);
    expect(primed?.profileId).toBe("usr_a");
    expect(fetchCount).toBe(1);

    // Issuer rotates: same kid now serves keyB material; mint with keyB.
    servedKeys = [keyB.jwk];
    const tokenB = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_b")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keyB.signKey);

    fetchCount = 0;
    const rotated = await extractClaims(`Bearer ${tokenB}`, JWKS_URL);
    // Cached keyA fails signature → one forced refresh picks up keyB.
    expect(rotated?.profileId).toBe("usr_b");
    expect(fetchCount).toBe(1);
  });

  // X2: issuer enforcement matrix.
  const ISS = "https://osn-api.example.com";

  it("issuer set + matching iss → claims resolve", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_a")
      .setIssuer(ISS)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keyA.signKey);

    const result = await extractClaims(`Bearer ${token}`, JWKS_URL, { issuer: ISS });
    expect(result?.profileId).toBe("usr_a");
  });

  it("issuer set + mismatched iss → null, terminal (NO refresh fetch)", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_a")
      .setIssuer("https://evil.example.com")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keyA.signKey);

    const result = await extractClaims(`Bearer ${token}`, JWKS_URL, { issuer: ISS });
    expect(result).toBeNull();
    // Issuer mismatch is terminal — a fresh key cannot change `iss`.
    expect(fetchCount).toBe(1); // resolve only, no rotation retry
  });

  it("issuer UNSET → any iss accepted (rollout safety: pre-O1 tokens verify)", async () => {
    // Token with an arbitrary iss, verified WITHOUT an expected issuer.
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_a")
      .setIssuer("https://anything.example.com")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keyA.signKey);

    const result = await extractClaims(`Bearer ${token}`, JWKS_URL);
    expect(result?.profileId).toBe("usr_a");

    // And a token with NO iss claim at all still verifies when issuer unset.
    const noIss = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_b")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keyA.signKey);
    const result2 = await extractClaims(`Bearer ${noIss}`, JWKS_URL);
    expect(result2?.profileId).toBe("usr_b");
  });

  // X2: clock-skew tolerance (±30s).
  it("token expired 10s ago → still accepted (within 30s clockTolerance)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_a")
      .setIssuedAt(now - 70)
      .setExpirationTime(now - 10) // 10s in the past, inside the 30s skew
      .sign(keyA.signKey);

    const result = await extractClaims(`Bearer ${token}`, JWKS_URL);
    expect(result?.profileId).toBe("usr_a");
  });

  it("token issued 10s in the future → accepted (nbf/iat within 30s skew)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_a")
      .setNotBefore(now + 10) // not-yet-valid, but inside the 30s skew
      .setIssuedAt(now + 10)
      .setExpirationTime(now + 300)
      .sign(keyA.signKey);

    const result = await extractClaims(`Bearer ${token}`, JWKS_URL);
    expect(result?.profileId).toBe("usr_a");
  });

  it("token expired 60s ago → rejected (outside 30s clockTolerance)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: kidA })
      .setSubject("usr_a")
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60) // 60s past, beyond the 30s skew
      .sign(keyA.signKey);

    const result = await extractClaims(`Bearer ${token}`, JWKS_URL);
    expect(result).toBeNull();
  });
});
