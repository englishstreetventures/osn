import { it as effectIt } from "@effect/vitest";
import { serviceAccounts, serviceAccountKeys } from "@osn/db";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  generateArcKeyPair,
  exportKeyToJwk,
  publicKeyCacheSize,
  _setPublicKeyCacheMaxSizeForTest,
  _resetPublicKeyCacheMaxSize,
  importKeyFromJwk,
  createArcToken,
  verifyArcToken,
  resolvePublicKey,
  clearPublicKeyCache,
  evictPublicKeyCacheEntry,
  getOrCreateArcToken,
  clearTokenCache,
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
      kid: "test-kid",
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
      { iss: "pulse-api", aud: "osn-core", scope: "graph:read", kid: "test-kid" },
      60,
    );
    const payload = await verifyArcToken(token, publicKey, "osn-core");
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(61);
    expect(payload.exp - payload.iat).toBeGreaterThanOrEqual(59);
  });

  it("rejects TTL of 0", async () => {
    await expect(
      createArcToken(privateKey, { iss: "a", aud: "b", scope: "graph:read", kid: "k" }, 0),
    ).rejects.toThrow("Invalid TTL");
  });

  it("rejects TTL > 600", async () => {
    await expect(
      createArcToken(privateKey, { iss: "a", aud: "b", scope: "graph:read", kid: "k" }, 700),
    ).rejects.toThrow("Invalid TTL");
  });

  it("accepts TTL at boundary: 1", async () => {
    const token = await createArcToken(
      privateKey,
      { iss: "a", aud: "b", scope: "graph:read", kid: "k" },
      1,
    );
    expect(typeof token).toBe("string");
  });

  it("accepts TTL at boundary: 600", async () => {
    const token = await createArcToken(
      privateKey,
      { iss: "a", aud: "b", scope: "graph:read", kid: "k" },
      600,
    );
    expect(typeof token).toBe("string");
  });

  it("rejects wrong audience", async () => {
    const token = await createArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "graph:read",
      kid: "test-kid",
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
      kid: "evil-kid",
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
      kid: "test-kid",
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
      kid: "test-kid",
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
      kid: "test-kid",
    });
    const payload = await verifyArcToken(token, publicKey, "osn-core", "graph:read");
    expect(payload.scope).toBe("graph:read");
  });

  it("rejects invalid scope format", async () => {
    await expect(
      createArcToken(privateKey, { iss: "a", aud: "b", scope: "bad scope!", kid: "k" }),
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
    const claims = { iss: "pulse-api", aud: "osn-core", scope: "graph:read", kid: "test-kid" };
    const token1 = await getOrCreateArcToken(privateKey, claims);
    const token2 = await getOrCreateArcToken(privateKey, claims);
    expect(token1).toBe(token2);
  });

  it("returns different tokens for different claims", async () => {
    const token1 = await getOrCreateArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "graph:read",
      kid: "test-kid",
    });
    const token2 = await getOrCreateArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-core",
      scope: "graph:write",
      kid: "test-kid",
    });
    expect(token1).not.toBe(token2);
  });

  it("cached token is valid", async () => {
    const claims = { iss: "pulse-api", aud: "osn-core", scope: "graph:read", kid: "test-kid" };
    const token = await getOrCreateArcToken(privateKey, claims);
    const payload = await verifyArcToken(token, publicKey, "osn-core");
    expect(payload.iss).toBe("pulse-api");
  });

  it("validates TTL before caching", async () => {
    await expect(
      getOrCreateArcToken(privateKey, { iss: "a", aud: "b", scope: "graph:read", kid: "k" }, 0),
    ).rejects.toThrow("Invalid TTL");
  });

  it("reissues token within 30s of expiry", async () => {
    const claims = { iss: "pulse-api", aud: "osn-core", scope: "graph:read", kid: "test-kid" };
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
    const claims = { iss: "pulse-api", aud: "osn-core", scope: "graph:read", kid: "test-kid" };

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

    await getOrCreateArcToken(
      keyPair.privateKey,
      { iss: "a", aud: "b", scope: "graph:read", kid: "k1" },
      300,
    );
    await getOrCreateArcToken(
      keyPair.privateKey,
      { iss: "c", aud: "d", scope: "graph:read", kid: "k2" },
      1,
    );
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
      const keyId = "test-key-1";

      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccounts).values({
            serviceId: "pulse-api",
            allowedScopes: "graph:read,graph:write",
            createdAt: now,
            updatedAt: now,
          }),
        catch: (e) => new ArcTokenError({ message: "insert service_accounts failed", cause: e }),
      });
      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccountKeys).values({
            keyId,
            serviceId: "pulse-api",
            publicKeyJwk: jwk,
            registeredAt: now,
            expiresAt: null,
            revokedAt: null,
          }),
        catch: (e) =>
          new ArcTokenError({ message: "insert service_account_keys failed", cause: e }),
      });

      const resolvedKey = yield* resolvePublicKey(keyId, "pulse-api");
      expect(resolvedKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });

      // Verify a token created with the original key can be verified with the resolved key
      const token = yield* Effect.promise(() =>
        createArcToken(keyPair.privateKey, {
          iss: "pulse-api",
          aud: "osn-core",
          scope: "graph:read",
          kid: keyId,
        }),
      );
      const payload = yield* Effect.promise(() => verifyArcToken(token, resolvedKey, "osn-core"));
      expect(payload.iss).toBe("pulse-api");
    }).pipe(Effect.provide(createTestLayer())),
  );

  effectIt.effect("fails for unknown key id", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolvePublicKey("no-such-key", "unknown-service"));
      expect(error._tag).toBe("ArcTokenError");
      expect(error.message).toContain("Unknown or invalid key");
    }).pipe(Effect.provide(createTestLayer())),
  );

  effectIt.effect("validates token scopes against allowedScopes", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const keyPair = yield* Effect.promise(() => generateArcKeyPair());
      const jwk = yield* Effect.promise(() => exportKeyToJwk(keyPair.publicKey));
      const now = new Date();
      const keyId = "limited-key-1";

      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccounts).values({
            serviceId: "limited-svc",
            allowedScopes: "graph:read",
            createdAt: now,
            updatedAt: now,
          }),
        catch: (e) => new ArcTokenError({ message: "insert failed", cause: e }),
      });
      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccountKeys).values({
            keyId,
            serviceId: "limited-svc",
            publicKeyJwk: jwk,
            registeredAt: now,
            expiresAt: null,
            revokedAt: null,
          }),
        catch: (e) => new ArcTokenError({ message: "insert key failed", cause: e }),
      });

      // Allowed scope succeeds
      const key = yield* resolvePublicKey(keyId, "limited-svc", ["graph:read"]);
      expect(key).toBeDefined();

      // Disallowed scope fails
      const error = yield* Effect.flip(resolvePublicKey(keyId, "limited-svc", ["graph:write"]));
      expect(error._tag).toBe("ArcTokenError");
      expect(error.message).toContain("not authorised for scope");
    }).pipe(Effect.provide(createTestLayer())),
  );

  effectIt.effect("rejects a revoked key", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const keyPair = yield* Effect.promise(() => generateArcKeyPair());
      const jwk = yield* Effect.promise(() => exportKeyToJwk(keyPair.publicKey));
      const now = new Date();
      const keyId = "revoked-key-1";

      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccounts).values({
            serviceId: "revoked-svc",
            allowedScopes: "graph:read",
            createdAt: now,
            updatedAt: now,
          }),
        catch: (e) => new ArcTokenError({ message: "insert failed", cause: e }),
      });
      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccountKeys).values({
            keyId,
            serviceId: "revoked-svc",
            publicKeyJwk: jwk,
            registeredAt: now,
            expiresAt: null,
            revokedAt: Math.floor(Date.now() / 1000) - 60, // revoked 1min ago
          }),
        catch: (e) => new ArcTokenError({ message: "insert key failed", cause: e }),
      });

      const error = yield* Effect.flip(resolvePublicKey(keyId, "revoked-svc"));
      expect(error._tag).toBe("ArcTokenError");
      expect(error.message).toContain("Unknown or invalid key");
    }).pipe(Effect.provide(createTestLayer())),
  );

  effectIt.effect("rejects an expired key", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const keyPair = yield* Effect.promise(() => generateArcKeyPair());
      const jwk = yield* Effect.promise(() => exportKeyToJwk(keyPair.publicKey));
      const now = new Date();
      const keyId = "expired-key-1";

      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccounts).values({
            serviceId: "expired-svc",
            allowedScopes: "graph:read",
            createdAt: now,
            updatedAt: now,
          }),
        catch: (e) => new ArcTokenError({ message: "insert failed", cause: e }),
      });
      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccountKeys).values({
            keyId,
            serviceId: "expired-svc",
            publicKeyJwk: jwk,
            registeredAt: now,
            expiresAt: Math.floor(Date.now() / 1000) - 60, // expired 1min ago
            revokedAt: null,
          }),
        catch: (e) => new ArcTokenError({ message: "insert key failed", cause: e }),
      });

      const error = yield* Effect.flip(resolvePublicKey(keyId, "expired-svc"));
      expect(error._tag).toBe("ArcTokenError");
      expect(error.message).toContain("Unknown or invalid key");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // T-E1: cache-hit scope enforcement path
  effectIt.effect("enforces scope on cache-hit path without re-querying DB", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const keyPair = yield* Effect.promise(() => generateArcKeyPair());
      const jwk = yield* Effect.promise(() => exportKeyToJwk(keyPair.publicKey));
      const now = new Date();
      const keyId = "cache-hit-scope-key";

      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccounts).values({
            serviceId: "cache-hit-svc",
            allowedScopes: "graph:read",
            createdAt: now,
            updatedAt: now,
          }),
        catch: (e) => new ArcTokenError({ message: "insert failed", cause: e }),
      });
      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccountKeys).values({
            keyId,
            serviceId: "cache-hit-svc",
            publicKeyJwk: jwk,
            registeredAt: now,
            expiresAt: null,
            revokedAt: null,
          }),
        catch: (e) => new ArcTokenError({ message: "insert key failed", cause: e }),
      });

      // First call: DB path — populates cache with allowedScopes "graph:read"
      const key = yield* resolvePublicKey(keyId, "cache-hit-svc", ["graph:read"]);
      expect(key).toBeDefined();

      // Second call: cache-hit path — "graph:write" not in cached allowedScopes
      // (No clearPublicKeyCache between calls — intentional to hit cache)
      const error = yield* Effect.flip(resolvePublicKey(keyId, "cache-hit-svc", ["graph:write"]));
      expect(error._tag).toBe("ArcTokenError");
      expect(error.message).toContain("not authorised for scope");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // T-U1: evictPublicKeyCacheEntry forces re-lookup and respects DB revocation
  effectIt.effect("evictPublicKeyCacheEntry forces DB re-lookup and sees revocation", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const keyPair = yield* Effect.promise(() => generateArcKeyPair());
      const jwk = yield* Effect.promise(() => exportKeyToJwk(keyPair.publicKey));
      const now = new Date();
      const keyId = "evict-cache-key";

      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccounts).values({
            serviceId: "evict-svc",
            allowedScopes: "graph:read",
            createdAt: now,
            updatedAt: now,
          }),
        catch: (e) => new ArcTokenError({ message: "insert failed", cause: e }),
      });
      yield* Effect.tryPromise({
        try: () =>
          db.insert(serviceAccountKeys).values({
            keyId,
            serviceId: "evict-svc",
            publicKeyJwk: jwk,
            registeredAt: now,
            expiresAt: null,
            revokedAt: null,
          }),
        catch: (e) => new ArcTokenError({ message: "insert key failed", cause: e }),
      });

      // Populate cache
      const cachedKey = yield* resolvePublicKey(keyId, "evict-svc");
      expect(cachedKey).toBeDefined();

      // Revoke key in DB (simulates /service-keys/:keyId DELETE)
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(serviceAccountKeys)
            .set({ revokedAt: Math.floor(Date.now() / 1000) })
            .where(eq(serviceAccountKeys.keyId, keyId)),
        catch: (e) => new ArcTokenError({ message: "revoke failed", cause: e }),
      });

      // Without eviction, cache still serves the stale key
      const staleKey = yield* resolvePublicKey(keyId, "evict-svc");
      expect(staleKey).toBeDefined();

      // Evict — next lookup hits DB and sees revokedAt
      evictPublicKeyCacheEntry(keyId);
      const error = yield* Effect.flip(resolvePublicKey(keyId, "evict-svc"));
      expect(error._tag).toBe("ArcTokenError");
      expect(error.message).toContain("Unknown or invalid key");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// P-W25: publicKeyCache LRU eviction
// ---------------------------------------------------------------------------

describe("publicKeyCache LRU eviction", () => {
  /** Insert a service account + key into the DB and resolve its public key (warm the cache). */
  async function seedAndResolve(
    layer: ReturnType<typeof createTestLayer>,
    serviceId: string,
    keyId: string,
  ): Promise<CryptoKey> {
    const run = <A>(eff: Effect.Effect<A, unknown, Db>) =>
      Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

    const kp = await generateArcKeyPair();
    const jwk = await exportKeyToJwk(kp.publicKey);
    const now = new Date();

    await run(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.tryPromise({
          try: () =>
            db.insert(serviceAccounts).values({
              serviceId,
              allowedScopes: "graph:read",
              createdAt: now,
              updatedAt: now,
            }),
          catch: (e) => e,
        });
        yield* Effect.tryPromise({
          try: () =>
            db.insert(serviceAccountKeys).values({
              keyId,
              serviceId,
              publicKeyJwk: jwk,
              registeredAt: now,
              expiresAt: null,
              revokedAt: null,
            }),
          catch: (e) => e,
        });
      }),
    );

    return run(resolvePublicKey(keyId, serviceId));
  }

  beforeEach(() => {
    clearPublicKeyCache();
    _setPublicKeyCacheMaxSizeForTest(3);
  });

  afterEach(() => {
    clearPublicKeyCache();
    _resetPublicKeyCacheMaxSize();
  });

  it("evicts the least-recently-used entry, not the first-inserted one", async () => {
    const layer = createTestLayer();
    const run = <A>(eff: Effect.Effect<A, unknown, Db>) =>
      Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

    // Fill cache to max (3): A, B, C inserted in order → A is oldest/LRU
    await seedAndResolve(layer, "svc-a", "key-a");
    await seedAndResolve(layer, "svc-b", "key-b");
    await seedAndResolve(layer, "svc-c", "key-c");
    expect(publicKeyCacheSize()).toBe(3);

    // Delete B from the DB so it cannot be re-resolved after cache eviction.
    // This lets us distinguish "evicted and gone" from "evicted but re-fetched from DB".
    await run(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.tryPromise({
          try: () => db.delete(serviceAccountKeys).where(eq(serviceAccountKeys.keyId, "key-b")),
          catch: (e) => e,
        });
      }),
    );

    // Touch A — makes A the MRU; B is now the LRU
    await run(resolvePublicKey("key-a", "svc-a"));

    // Insert D — should evict B (LRU), not A (recently touched)
    await seedAndResolve(layer, "svc-d", "key-d");
    expect(publicKeyCacheSize()).toBe(3);

    // A, C, D remain in cache; B was the LRU and is now gone from both cache and DB
    const [resA, resB, resC, resD] = await Promise.all([
      Effect.runPromise(
        Effect.either(resolvePublicKey("key-a", "svc-a")).pipe(Effect.provide(layer)),
      ),
      Effect.runPromise(
        Effect.either(resolvePublicKey("key-b", "svc-b")).pipe(Effect.provide(layer)),
      ),
      Effect.runPromise(
        Effect.either(resolvePublicKey("key-c", "svc-c")).pipe(Effect.provide(layer)),
      ),
      Effect.runPromise(
        Effect.either(resolvePublicKey("key-d", "svc-d")).pipe(Effect.provide(layer)),
      ),
    ]);

    expect(resA._tag).toBe("Right"); // A survived (was touched → MRU)
    expect(resB._tag).toBe("Left"); // B evicted (was LRU) and deleted from DB
    expect(resC._tag).toBe("Right"); // C survived
    expect(resD._tag).toBe("Right"); // D just inserted
  });

  it("cache size stays bounded at the configured max", async () => {
    const layer = createTestLayer();
    // Insert sequentially so eviction order is deterministic
    await seedAndResolve(layer, "svc-0", "key-0");
    await seedAndResolve(layer, "svc-1", "key-1");
    await seedAndResolve(layer, "svc-2", "key-2");
    await seedAndResolve(layer, "svc-3", "key-3");
    await seedAndResolve(layer, "svc-4", "key-4");
    await seedAndResolve(layer, "svc-5", "key-5");
    expect(publicKeyCacheSize()).toBe(3);
  });

  // T-S1: a scope-denied cache hit must NOT promote the entry to MRU
  it("scope-failure hit does not update lastAccess — entry still gets evicted (T-S1)", async () => {
    const layer = createTestLayer();
    const run = <A>(eff: Effect.Effect<A, unknown, Db>) =>
      Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

    // Fill cache: A (oldest), B, C — A's lastAccess is the earliest
    await seedAndResolve(layer, "ts1-svc-a", "ts1-key-a");
    await seedAndResolve(layer, "ts1-svc-b", "ts1-key-b");
    await seedAndResolve(layer, "ts1-svc-c", "ts1-key-c");
    expect(publicKeyCacheSize()).toBe(3);

    // Delete A from DB so we can detect eviction (cache miss → DB miss → error)
    await run(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.tryPromise({
          try: () => db.delete(serviceAccountKeys).where(eq(serviceAccountKeys.keyId, "ts1-key-a")),
          catch: (e) => e,
        });
      }),
    );

    // Scope-denied hit on A — "graph:write" not in allowedScopes ("graph:read")
    // This should NOT update lastAccess for A; A remains the LRU candidate
    await run(
      Effect.gen(function* () {
        const err = yield* Effect.flip(resolvePublicKey("ts1-key-a", "ts1-svc-a", ["graph:write"]));
        expect(err._tag).toBe("ArcTokenError");
      }),
    );

    // Insert D → eviction must pick A (lowest lastAccess), not B or C
    await seedAndResolve(layer, "ts1-svc-d", "ts1-key-d");
    expect(publicKeyCacheSize()).toBe(3);

    // A evicted and not in DB → fails; B, C, D survive
    const resA = await Effect.runPromise(
      Effect.either(resolvePublicKey("ts1-key-a", "ts1-svc-a")).pipe(Effect.provide(layer)),
    );
    const resB = await Effect.runPromise(
      Effect.either(resolvePublicKey("ts1-key-b", "ts1-svc-b")).pipe(Effect.provide(layer)),
    );
    expect(resA._tag).toBe("Left"); // A was evicted and deleted from DB
    expect(resB._tag).toBe("Right"); // B survived — was not LRU
  });

  // T-S2: cap=1 boundary — only one entry fits at a time
  it("cap=1: second entry evicts first, size stays 1 (T-S2)", async () => {
    clearPublicKeyCache();
    _setPublicKeyCacheMaxSizeForTest(1);

    const layer = createTestLayer();
    await seedAndResolve(layer, "t2-svc-a", "t2-key-a");
    expect(publicKeyCacheSize()).toBe(1);

    await seedAndResolve(layer, "t2-svc-b", "t2-key-b");
    expect(publicKeyCacheSize()).toBe(1);
  });
});
