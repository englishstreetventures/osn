import { serviceAccounts, serviceAccountKeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { Db as DbTag } from "@osn/db/service";
import {
  generateArcKeyPair,
  exportKeyToJwk,
  createArcToken,
  clearPublicKeyCache,
} from "@shared/crypto";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

import { createInternalGraphRoutes } from "../../src/routes/graph-internal";
import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("internal graph routes (ARC-protected)", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let app: ReturnType<typeof createInternalGraphRoutes>;
  let auth: ReturnType<typeof createAuthService>;
  let graph: ReturnType<typeof createGraphService>;

  const runWithLayer = <A>(eff: Effect.Effect<A, unknown, DbTag>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

  /** Register a service account and return a valid ARC token for it. */
  async function setupArcService(
    serviceId: string = "pulse-api",
    scopes: string = "graph:read",
    audience: string = "osn-api",
  ): Promise<{ token: string; keyPair: CryptoKeyPair; keyId: string }> {
    const kp = await generateArcKeyPair();
    const pubJwk = await exportKeyToJwk(kp.publicKey);
    const now = new Date();
    const keyId = crypto.randomUUID();

    await runWithLayer(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.tryPromise({
          try: () =>
            db.insert(serviceAccounts).values({
              serviceId,
              allowedScopes: scopes,
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
              publicKeyJwk: pubJwk,
              registeredAt: now,
              expiresAt: null,
              revokedAt: null,
            }),
          catch: (e) => e,
        });
      }),
    );

    const token = await createArcToken(kp.privateKey, {
      iss: serviceId,
      aud: audience,
      scope: scopes,
      kid: keyId,
    });

    return { token, keyPair: kp, keyId };
  }

  /** Register a user in the OSN DB. */
  async function registerProfile(email: string, handle: string): Promise<string> {
    const user = await runWithLayer(auth.registerProfile(email, handle));
    return user.id;
  }

  beforeEach(() => {
    clearPublicKeyCache();
    layer = createTestLayer();
    app = createInternalGraphRoutes(layer);
    auth = createAuthService(config);
    graph = createGraphService();
  });

  // -------------------------------------------------------------------------
  // ARC auth guard
  // -------------------------------------------------------------------------

  describe("ARC auth guard", () => {
    it("returns 401 without authorization header", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b"),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with Bearer token instead of ARC token", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: "Bearer some-jwt" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid ARC token", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: "ARC not-a-valid-token" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with unregistered service", async () => {
      const kp = await generateArcKeyPair();
      const token = await createArcToken(kp.privateKey, {
        iss: "unknown-service",
        aud: "osn-api",
        scope: "graph:read",
        kid: "no-such-key",
      });

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong audience", async () => {
      const { keyPair: kp, keyId } = await setupArcService("pulse-api", "graph:read", "osn-api");
      // Create token with wrong audience
      const badToken = await createArcToken(kp.privateKey, {
        iss: "pulse-api",
        aud: "wrong-service",
        scope: "graph:read",
        kid: keyId,
      });

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: `ARC ${badToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong scope", async () => {
      const { keyPair: kp, keyId } = await setupArcService("pulse-api", "graph:read", "osn-api");
      // Create token with wrong scope (service is only allowed graph:read)
      const badToken = await createArcToken(kp.privateKey, {
        iss: "pulse-api",
        aud: "osn-api",
        scope: "graph:write",
        kid: keyId,
      });

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: `ARC ${badToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with expired ARC token", async () => {
      const { keyPair: kp, keyId } = await setupArcService("pulse-api", "graph:read", "osn-api");
      // Create token with minimum TTL (1 second)
      const expiredToken = await createArcToken(
        kp.privateKey,
        { iss: "pulse-api", aud: "osn-api", scope: "graph:read", kid: keyId },
        1,
      );

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 1100));

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: `ARC ${expiredToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("rejects missing ARC token on all endpoints", async () => {
      const endpoints = [
        { url: "/graph/internal/either-blocked?profileA=a&profileB=b", method: "GET" },
        { url: "/graph/internal/connection-status?viewerId=a&targetId=b", method: "GET" },
        { url: "/graph/internal/connections?profileId=a", method: "GET" },
        {
          url: "/graph/internal/profile-displays",
          method: "POST",
          body: JSON.stringify({ profileIds: ["a"] }),
        },
      ];

      for (const ep of endpoints) {
        const init: RequestInit = { method: ep.method };
        if (ep.body) {
          init.headers = { "Content-Type": "application/json" };
          init.body = ep.body;
        }
        // eslint-disable-next-line no-await-in-loop -- sequential endpoint verification
        const res = await app.handle(new Request(`http://localhost${ep.url}`, init));
        expect(res.status, `expected 401 on ${ep.method} ${ep.url}`).toBe(401);
      }
    });

    it("succeeds with valid ARC token", async () => {
      const { token } = await setupArcService();

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { blocked: boolean };
      expect(body.blocked).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // /graph/internal/either-blocked
  // -------------------------------------------------------------------------

  describe("GET /graph/internal/either-blocked", () => {
    it("returns false when neither user has blocked the other", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");

      const res = await app.handle(
        new Request(
          `http://localhost/graph/internal/either-blocked?profileA=${alice}&profileB=${bob}`,
          {
            headers: { Authorization: `ARC ${token}` },
          },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { blocked: boolean };
      expect(body.blocked).toBe(false);
    });

    it("returns true when one user has blocked the other", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");

      await runWithLayer(graph.blockProfile(alice, bob));

      const res = await app.handle(
        new Request(
          `http://localhost/graph/internal/either-blocked?profileA=${alice}&profileB=${bob}`,
          {
            headers: { Authorization: `ARC ${token}` },
          },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { blocked: boolean };
      expect(body.blocked).toBe(true);
    });

    it("detects reverse block direction", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");

      await runWithLayer(graph.blockProfile(bob, alice));

      // Query with alice as userA, bob as userB — should still detect the block
      const res = await app.handle(
        new Request(
          `http://localhost/graph/internal/either-blocked?profileA=${alice}&profileB=${bob}`,
          {
            headers: { Authorization: `ARC ${token}` },
          },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { blocked: boolean };
      expect(body.blocked).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // /graph/internal/connection-status
  // -------------------------------------------------------------------------

  describe("GET /graph/internal/connection-status", () => {
    it("returns 'none' for unrelated users", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");

      const res = await app.handle(
        new Request(
          `http://localhost/graph/internal/connection-status?viewerId=${alice}&targetId=${bob}`,
          { headers: { Authorization: `ARC ${token}` } },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("none");
    });

    it("returns 'connected' for connected users", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");

      await runWithLayer(graph.sendConnectionRequest(alice, bob));
      await runWithLayer(graph.acceptConnection(bob, alice));

      const res = await app.handle(
        new Request(
          `http://localhost/graph/internal/connection-status?viewerId=${alice}&targetId=${bob}`,
          { headers: { Authorization: `ARC ${token}` } },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("connected");
    });
  });

  // -------------------------------------------------------------------------
  // /graph/internal/connections
  // -------------------------------------------------------------------------

  describe("GET /graph/internal/connections", () => {
    it("returns empty list for user with no connections", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/connections?profileId=${alice}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connectionIds: string[] };
      expect(body.connectionIds).toEqual([]);
    });

    it("returns connection IDs", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");

      await runWithLayer(graph.sendConnectionRequest(alice, bob));
      await runWithLayer(graph.acceptConnection(bob, alice));

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/connections?profileId=${alice}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connectionIds: string[] };
      expect(body.connectionIds).toContain(bob);
    });
  });

  // -------------------------------------------------------------------------
  // POST /graph/internal/profile-displays
  // -------------------------------------------------------------------------

  describe("POST /graph/internal/profile-displays", () => {
    it("returns empty array for empty input", async () => {
      const { token } = await setupArcService();

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-displays", {
          method: "POST",
          headers: {
            Authorization: `ARC ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ profileIds: [] }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: unknown[] };
      expect(body.profiles).toEqual([]);
    });

    it("returns user display metadata", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-displays", {
          method: "POST",
          headers: {
            Authorization: `ARC ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ profileIds: [alice] }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        profiles: {
          id: string;
          handle: string;
          displayName: string | null;
          avatarUrl: string | null;
        }[];
      };
      expect(body.profiles).toHaveLength(1);
      expect(body.profiles[0].id).toBe(alice);
      expect(body.profiles[0].handle).toBe("alice");
    });
  });

  // -------------------------------------------------------------------------
  // GET /graph/internal/profile-account
  // -------------------------------------------------------------------------

  describe("GET /graph/internal/profile-account", () => {
    it("returns the accountId that owns the profile", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/profile-account?profileId=${alice}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accountId: string };
      expect(typeof body.accountId).toBe("string");
      expect(body.accountId).toMatch(/^acc_/);
    });

    it("returns 404 when profile does not exist", async () => {
      const { token } = await setupArcService();

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-account?profileId=usr_missing", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Profile not found");
    });

    it("rejects missing ARC token with 401", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-account?profileId=usr_x"),
      );
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // POST /graph/internal/register-service  (T-R1)
  // -------------------------------------------------------------------------

  describe("POST /graph/internal/register-service", () => {
    const SECRET = "test-internal-secret";
    let validBody: {
      serviceId: string;
      keyId: string;
      publicKeyJwk: string;
      allowedScopes: string;
    };

    beforeEach(async () => {
      process.env.INTERNAL_SERVICE_SECRET = SECRET;
      // S-M1 requires a genuinely importable JWK — generate a real key pair.
      const kp = await generateArcKeyPair();
      validBody = {
        serviceId: "zap-api",
        keyId: "key-reg-1",
        publicKeyJwk: await exportKeyToJwk(kp.publicKey),
        allowedScopes: "graph:read",
      };
    });

    afterEach(() => {
      delete process.env.INTERNAL_SERVICE_SECRET;
    });

    it("returns 501 when INTERNAL_SERVICE_SECRET is unset", async () => {
      delete process.env.INTERNAL_SERVICE_SECRET;
      const res = await app.handle(
        new Request("http://localhost/graph/internal/register-service", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify(validBody),
        }),
      );
      expect(res.status).toBe(501);
    });

    it("returns 401 with wrong secret", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/register-service", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-secret" },
          body: JSON.stringify(validBody),
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 400 when requested scope is not in allowlist", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/register-service", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SECRET}`,
          },
          body: JSON.stringify({ ...validBody, allowedScopes: "admin:write" }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Unknown scopes");
    });

    it("returns 200 and upserts the service account and key", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/register-service", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SECRET}`,
          },
          body: JSON.stringify(validBody),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify key row was inserted
      const rows = await runWithLayer(
        Effect.gen(function* () {
          const { db } = yield* Db;
          return yield* Effect.tryPromise({
            try: () =>
              db
                .select()
                .from(serviceAccountKeys)
                .where(eq(serviceAccountKeys.keyId, validBody.keyId)),
            catch: (e) => e,
          });
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.serviceId).toBe(validBody.serviceId);
    });

    it("upserts on re-registration — allowedScopes updated", async () => {
      const makeRequest = (scopes: string) =>
        app.handle(
          new Request("http://localhost/graph/internal/register-service", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SECRET}`,
            },
            body: JSON.stringify({ ...validBody, keyId: "key-upsert-1", allowedScopes: scopes }),
          }),
        );

      await makeRequest("graph:read");
      const res2 = await makeRequest("graph:read");
      expect(res2.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /graph/internal/service-keys/:keyId  (T-R2)
  // -------------------------------------------------------------------------

  describe("DELETE /graph/internal/service-keys/:keyId", () => {
    const SECRET = "test-internal-secret";

    beforeEach(() => {
      process.env.INTERNAL_SERVICE_SECRET = SECRET;
    });

    afterEach(() => {
      delete process.env.INTERNAL_SERVICE_SECRET;
    });

    it("returns 501 when INTERNAL_SERVICE_SECRET is unset", async () => {
      delete process.env.INTERNAL_SERVICE_SECRET;
      const res = await app.handle(
        new Request("http://localhost/graph/internal/service-keys/some-key", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${SECRET}` },
        }),
      );
      expect(res.status).toBe(501);
    });

    it("returns 401 with wrong secret", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/service-keys/some-key", {
          method: "DELETE",
          headers: { Authorization: "Bearer wrong-secret" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 200 and sets revokedAt on the key row", async () => {
      const { keyId } = await setupArcService("revoke-svc", "graph:read");

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/service-keys/${keyId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${SECRET}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      const rows = await runWithLayer(
        Effect.gen(function* () {
          const { db } = yield* Db;
          return yield* Effect.tryPromise({
            try: () =>
              db.select().from(serviceAccountKeys).where(eq(serviceAccountKeys.keyId, keyId)),
            catch: (e) => e,
          });
        }),
      );
      expect(rows[0]?.revokedAt).not.toBeNull();
    });

    it("after revocation, ARC-protected requests using the key return 401", async () => {
      const { token, keyId } = await setupArcService("evict-test-svc", "graph:read");

      // Confirm the token works before revocation
      const pre = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(pre.status).toBe(200);

      // Revoke the key — also evicts cache entry
      await app.handle(
        new Request(`http://localhost/graph/internal/service-keys/${keyId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${SECRET}` },
        }),
      );

      // Same token now rejected (cache evicted + key revoked in DB)
      const post = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(post.status).toBe(401);
    });
  });
});
