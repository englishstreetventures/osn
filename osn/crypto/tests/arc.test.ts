import { it as effectIt } from "@effect/vitest";
import { serviceAccounts } from "@osn/db";
import { Db } from "@osn/db/service";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  generateArcKeyPair,
  exportKeyToJwk,
  importKeyFromJwk,
  createArcToken,
  verifyArcToken,
  resolvePublicKey,
  getOrCreateArcToken,
  clearTokenCache,
  clearPublicKeyCache,
  evictExpiredTokens,
  tokenCacheSize,
  ArcTokenError,
} from "../src/arc";
import { createTestLayer } from "./helpers/db";

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

describe("generateArcKeyPair", () => {
  it("generates an ES256 key pair", async () => {
    const keyPair = await generateArcKeyPair();
    expect(keyPair.privateKey).toBeDefined();
    expect(keyPair.publicKey).toBeDefined();
    expect(keyPair.privateKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
    expect(keyPair.publicKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
  });

  it("produces extractable keys", async () => {
    const keyPair = await generateArcKeyPair();
    expect(keyPair.privateKey.extractable).toBe(true);
    expect(keyPair.publicKey.extractable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Key import/export
// ---------------------------------------------------------------------------

describe("exportKeyToJwk / importKeyFromJwk", () => {
  it("round-trips a public key through JWK", async () => {
    const { publicKey } = await generateArcKeyPair();
    const jwk = await exportKeyToJwk(publicKey);
    const parsed = JSON.parse(jwk);
    expect(parsed.kty).toBe("EC");
    expect(parsed.crv).toBe("P-256");

    const imported = await importKeyFromJwk(jwk);
    expect(imported.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
  });

  it("round-trips a private key through JWK", async () => {
    const { privateKey } = await generateArcKeyPair();
    const jwk = await exportKeyToJwk(privateKey);
    const imported = await importKeyFromJwk(jwk);
    expect(imported.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
  });

  it("rejects JWK with wrong kty", async () => {
    const badJwk = JSON.stringify({ kty: "RSA", n: "abc", e: "AQAB" });
    await expect(importKeyFromJwk(badJwk)).rejects.toThrow('expected kty "EC"');
  });

  it("rejects JWK with wrong curve", async () => {
    const badJwk = JSON.stringify({ kty: "EC", crv: "P-384", x: "abc", y: "def" });
    await expect(importKeyFromJwk(badJwk)).rejects.toThrow('expected crv "P-256"');
  });

  it("rejects JWK missing coordinates", async () => {
    const badJwk = JSON.stringify({ kty: "EC", crv: "P-256" });
    await expect(importKeyFromJwk(badJwk)).rejects.toThrow("missing x or y");
  });
});

// ---------------------------------------------------------------------------
// Token creation + verification
// ---------------------------------------------------------------------------

describe("createArcToken / verifyArcToken", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    const keyPair = await generateArcKeyPair();
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;
  });

  it("creates a valid JWT that verifies successfully", async () => {
    const token = await createArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "graph:read",
    });

    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);

    const payload = await verifyArcToken(token, publicKey, "osn-core");
    expect(payload.iss).toBe("pulse-api");
    expect(payload.aud).toBe("osn-core");
    expect(payload.scope).toBe("graph:read");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("respects custom TTL", async () => {
    const token = await createArcToken(
      privateKey,
      { iss: "pulse-api", aud: "osn-core", scope: "graph:read" },
      60,
    );
    const payload = await verifyArcToken(token, publicKey, "osn-core");
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(61);
    expect(payload.exp - payload.iat).toBeGreaterThanOrEqual(59);
  });

  it("rejects TTL of 0", async () => {
    await expect(
      createArcToken(privateKey, { iss: "a", aud: "b", scope: "graph:read" }, 0),
    ).rejects.toThrow("Invalid TTL");
  });

  it("rejects TTL > 600", async () => {
    await expect(
      createArcToken(privateKey, { iss: "a", aud: "b", scope: "graph:read" }, 700),
    ).rejects.toThrow("Invalid TTL");
  });

  it("accepts TTL at boundary: 1", async () => {
    const token = await createArcToken(privateKey, { iss: "a", aud: "b", scope: "graph:read" }, 1);
    expect(typeof token).toBe("string");
  });

  it("accepts TTL at boundary: 600", async () => {
    const token = await createArcToken(
      privateKey,
      { iss: "a", aud: "b", scope: "graph:read" },
      600,
    );
    expect(typeof token).toBe("string");
  });

  it("rejects wrong audience", async () => {
    const token = await createArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "graph:read",
    });

    await expect(verifyArcToken(token, publicKey, "wrong-service")).rejects.toThrow(
      "ARC token verification failed",
    );
  });

  it("rejects token signed with a different key", async () => {
    const otherKeyPair = await generateArcKeyPair();
    const token = await createArcToken(otherKeyPair.privateKey, {
      iss: "evil",
      aud: "osn-core",
      scope: "graph:read",
    });

    await expect(verifyArcToken(token, publicKey, "osn-core")).rejects.toThrow(
      "ARC token verification failed",
    );
  });

  it("validates required scope", async () => {
    const token = await createArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "graph:read",
    });

    const payload = await verifyArcToken(token, publicKey, "osn-core", "graph:read");
    expect(payload.scope).toBe("graph:read");

    await expect(verifyArcToken(token, publicKey, "osn-core", "graph:write")).rejects.toThrow(
      "missing required scope: graph:write",
    );
  });

  it("supports comma-separated scopes", async () => {
    const token = await createArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "graph:read,graph:write",
    });

    const payload = await verifyArcToken(token, publicKey, "osn-core", "graph:read");
    expect(payload.scope).toBe("graph:read,graph:write");

    const payload2 = await verifyArcToken(token, publicKey, "osn-core", "graph:write");
    expect(payload2.scope).toBe("graph:read,graph:write");
  });

  it("normalises scope to lowercase", async () => {
    const token = await createArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "Graph:Read",
    });
    const payload = await verifyArcToken(token, publicKey, "osn-core", "graph:read");
    expect(payload.scope).toBe("graph:read");
  });

  it("rejects invalid scope format", async () => {
    await expect(
      createArcToken(privateKey, { iss: "a", aud: "b", scope: "bad scope!" }),
    ).rejects.toThrow("Invalid scope format");
  });
});

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

describe("getOrCreateArcToken", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    clearTokenCache();
    const keyPair = await generateArcKeyPair();
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;
  });

  it("caches tokens and returns the same token on repeat calls", async () => {
    const claims = { iss: "pulse-api", aud: "osn-core", scope: "graph:read" };
    const token1 = await getOrCreateArcToken(privateKey, claims);
    const token2 = await getOrCreateArcToken(privateKey, claims);
    expect(token1).toBe(token2);
  });

  it("returns different tokens for different claims", async () => {
    const token1 = await getOrCreateArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "graph:read",
    });
    const token2 = await getOrCreateArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "graph:write",
    });
    expect(token1).not.toBe(token2);
  });

  it("cached token is valid", async () => {
    const claims = { iss: "pulse-api", aud: "osn-core", scope: "graph:read" };
    const token = await getOrCreateArcToken(privateKey, claims);
    const payload = await verifyArcToken(token, publicKey, "osn-core");
    expect(payload.iss).toBe("pulse-api");
  });

  it("validates TTL before caching", async () => {
    await expect(
      getOrCreateArcToken(privateKey, { iss: "a", aud: "b", scope: "graph:read" }, 0),
    ).rejects.toThrow("Invalid TTL");
  });

  it("reissues token within 30s of expiry", async () => {
    const claims = { iss: "pulse-api", aud: "osn-core", scope: "graph:read" };
    // Create a token with very short TTL (31s — will expire within reissue buffer soon)
    const token1 = await getOrCreateArcToken(privateKey, claims, 31);

    // Advance clock by 2s so that expiresAt - 30 <= now
    vi.useFakeTimers();
    vi.advanceTimersByTime(2_000);

    const token2 = await getOrCreateArcToken(privateKey, claims, 31);
    // token2 should be different because the original is within reissue buffer
    expect(token2).not.toBe(token1);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// evictExpiredTokens
// ---------------------------------------------------------------------------

describe("evictExpiredTokens", () => {
  beforeEach(() => {
    clearTokenCache();
  });

  it("removes expired entries", async () => {
    const keyPair = await generateArcKeyPair();
    const claims = { iss: "pulse-api", aud: "osn-core", scope: "graph:read" };

    // Create token with 1s TTL
    await getOrCreateArcToken(keyPair.privateKey, claims, 1);
    expect(tokenCacheSize()).toBe(1);

    // Advance past expiry
    vi.useFakeTimers();
    vi.advanceTimersByTime(2_000);

    evictExpiredTokens();
    expect(tokenCacheSize()).toBe(0);

    vi.useRealTimers();
  });

  it("preserves non-expired entries", async () => {
    const keyPair = await generateArcKeyPair();

    await getOrCreateArcToken(keyPair.privateKey, { iss: "a", aud: "b", scope: "graph:read" }, 300);
    await getOrCreateArcToken(keyPair.privateKey, { iss: "c", aud: "d", scope: "graph:read" }, 1);
    expect(tokenCacheSize()).toBe(2);

    vi.useFakeTimers();
    vi.advanceTimersByTime(2_000);

    evictExpiredTokens();
    // Only the 1s TTL token should be evicted
    expect(tokenCacheSize()).toBe(1);

    vi.useRealTimers();
  });

  it("is a no-op on empty cache", () => {
    expect(tokenCacheSize()).toBe(0);
    evictExpiredTokens();
    expect(tokenCacheSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolvePublicKey (Effect + DB)
// ---------------------------------------------------------------------------

describe("resolvePublicKey", () => {
  beforeEach(() => {
    clearPublicKeyCache();
  });

  effectIt.effect("resolves a registered service's public key", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const keyPair = yield* Effect.promise(() => generateArcKeyPair());
      const jwk = yield* Effect.promise(() => exportKeyToJwk(keyPair.publicKey));
      const now = new Date();

      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccounts).values({
            serviceId: "pulse-api",
            publicKeyJwk: jwk,
            allowedScopes: "graph:read,graph:write",
            createdAt: now,
            updatedAt: now,
          }),
        catch: (e) => new ArcTokenError({ message: "insert failed", cause: e }),
      });

      const resolvedKey = yield* resolvePublicKey("pulse-api");
      expect(resolvedKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });

      // Verify a token created with the original key can be verified with the resolved key
      const token = yield* Effect.promise(() =>
        createArcToken(keyPair.privateKey, {
          iss: "pulse-api",
          aud: "osn-core",
          scope: "graph:read",
        }),
      );
      const payload = yield* Effect.promise(() => verifyArcToken(token, resolvedKey, "osn-core"));
      expect(payload.iss).toBe("pulse-api");
    }).pipe(Effect.provide(createTestLayer())),
  );

  effectIt.effect("fails for unknown service", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolvePublicKey("unknown-service"));
      expect(error._tag).toBe("ArcTokenError");
      expect(error.message).toContain("Unknown service");
    }).pipe(Effect.provide(createTestLayer())),
  );

  effectIt.effect("validates token scopes against allowedScopes", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const keyPair = yield* Effect.promise(() => generateArcKeyPair());
      const jwk = yield* Effect.promise(() => exportKeyToJwk(keyPair.publicKey));
      const now = new Date();

      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccounts).values({
            serviceId: "limited-svc",
            publicKeyJwk: jwk,
            allowedScopes: "graph:read",
            createdAt: now,
            updatedAt: now,
          }),
        catch: (e) => new ArcTokenError({ message: "insert failed", cause: e }),
      });

      // Allowed scope succeeds
      const key = yield* resolvePublicKey("limited-svc", ["graph:read"]);
      expect(key).toBeDefined();

      // Disallowed scope fails
      const error = yield* Effect.flip(resolvePublicKey("limited-svc", ["graph:write"]));
      expect(error._tag).toBe("ArcTokenError");
      expect(error.message).toContain("not authorised for scope");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
