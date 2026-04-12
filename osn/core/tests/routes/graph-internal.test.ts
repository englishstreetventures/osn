import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { createTestLayer } from "../helpers/db";
import { createInternalGraphRoutes } from "../../src/routes/graph-internal";
import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";
import {
  generateArcKeyPair,
  exportKeyToJwk,
  createArcToken,
  clearPublicKeyCache,
} from "@osn/crypto";
import { serviceAccounts } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { Db as DbTag } from "@osn/db/service";

const config = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  jwtSecret: "test-secret-at-least-32-characters-long",
};

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
    audience: string = "osn-core",
  ): Promise<{ token: string; keyPair: CryptoKeyPair }> {
    const kp = await generateArcKeyPair();
    const pubJwk = await exportKeyToJwk(kp.publicKey);
    const now = new Date();

    await runWithLayer(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.tryPromise({
          try: () =>
            db.insert(serviceAccounts).values({
              serviceId,
              publicKeyJwk: pubJwk,
              allowedScopes: scopes,
              createdAt: now,
              updatedAt: now,
            }),
          catch: (e) => e,
        });
      }),
    );

    const token = await createArcToken(kp.privateKey, {
      iss: serviceId,
      aud: audience,
      scope: scopes,
    });

    return { token, keyPair: kp };
  }

  /** Register a user in the OSN DB. */
  async function registerUser(email: string, handle: string): Promise<string> {
    const user = await runWithLayer(auth.registerUser(email, handle));
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
        new Request("http://localhost/graph/internal/either-blocked?userA=a&userB=b"),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with Bearer token instead of ARC token", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?userA=a&userB=b", {
          headers: { Authorization: "Bearer some-jwt" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid ARC token", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?userA=a&userB=b", {
          headers: { Authorization: "ARC not-a-valid-token" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with unregistered service", async () => {
      const kp = await generateArcKeyPair();
      const token = await createArcToken(kp.privateKey, {
        iss: "unknown-service",
        aud: "osn-core",
        scope: "graph:read",
      });

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?userA=a&userB=b", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong audience", async () => {
      const { keyPair: kp } = await setupArcService("pulse-api", "graph:read", "osn-core");
      // Create token with wrong audience
      const badToken = await createArcToken(kp.privateKey, {
        iss: "pulse-api",
        aud: "wrong-service",
        scope: "graph:read",
      });

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?userA=a&userB=b", {
          headers: { Authorization: `ARC ${badToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong scope", async () => {
      const { keyPair: kp } = await setupArcService("pulse-api", "graph:read", "osn-core");
      // Create token with wrong scope (service is only allowed graph:read)
      const badToken = await createArcToken(kp.privateKey, {
        iss: "pulse-api",
        aud: "osn-core",
        scope: "graph:write",
      });

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?userA=a&userB=b", {
          headers: { Authorization: `ARC ${badToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with expired ARC token", async () => {
      const { keyPair: kp } = await setupArcService("pulse-api", "graph:read", "osn-core");
      // Create token with minimum TTL (1 second)
      const expiredToken = await createArcToken(
        kp.privateKey,
        { iss: "pulse-api", aud: "osn-core", scope: "graph:read" },
        1,
      );

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 1100));

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?userA=a&userB=b", {
          headers: { Authorization: `ARC ${expiredToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("rejects missing ARC token on all endpoints", async () => {
      const endpoints = [
        { url: "/graph/internal/either-blocked?userA=a&userB=b", method: "GET" },
        { url: "/graph/internal/connection-status?viewerId=a&targetId=b", method: "GET" },
        { url: "/graph/internal/connections?userId=a", method: "GET" },
        { url: "/graph/internal/close-friends?userId=a", method: "GET" },
        { url: "/graph/internal/is-close-friend?userId=a&friendId=b", method: "GET" },
        {
          url: "/graph/internal/close-friends-of",
          method: "POST",
          body: JSON.stringify({ viewerId: "a", userIds: ["b"] }),
        },
        {
          url: "/graph/internal/user-displays",
          method: "POST",
          body: JSON.stringify({ userIds: ["a"] }),
        },
      ];

      for (const ep of endpoints) {
        const init: RequestInit = { method: ep.method };
        if (ep.body) {
          init.headers = { "Content-Type": "application/json" };
          init.body = ep.body;
        }
        const res = await app.handle(new Request(`http://localhost${ep.url}`, init));
        expect(res.status, `expected 401 on ${ep.method} ${ep.url}`).toBe(401);
      }
    });

    it("succeeds with valid ARC token", async () => {
      const { token } = await setupArcService();

      const res = await app.handle(
        new Request("http://localhost/graph/internal/either-blocked?userA=a&userB=b", {
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
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/either-blocked?userA=${alice}&userB=${bob}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { blocked: boolean };
      expect(body.blocked).toBe(false);
    });

    it("returns true when one user has blocked the other", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

      await runWithLayer(graph.blockUser(alice, bob));

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/either-blocked?userA=${alice}&userB=${bob}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { blocked: boolean };
      expect(body.blocked).toBe(true);
    });

    it("detects reverse block direction", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

      await runWithLayer(graph.blockUser(bob, alice));

      // Query with alice as userA, bob as userB — should still detect the block
      const res = await app.handle(
        new Request(`http://localhost/graph/internal/either-blocked?userA=${alice}&userB=${bob}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
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
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

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
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

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
      const alice = await registerUser("alice@example.com", "alice");

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/connections?userId=${alice}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connectionIds: string[] };
      expect(body.connectionIds).toEqual([]);
    });

    it("returns connection IDs", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

      await runWithLayer(graph.sendConnectionRequest(alice, bob));
      await runWithLayer(graph.acceptConnection(bob, alice));

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/connections?userId=${alice}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connectionIds: string[] };
      expect(body.connectionIds).toContain(bob);
    });
  });

  // -------------------------------------------------------------------------
  // /graph/internal/close-friends
  // -------------------------------------------------------------------------

  describe("GET /graph/internal/close-friends", () => {
    it("returns close friend IDs", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

      // Must be connected before adding as close friend
      await runWithLayer(graph.sendConnectionRequest(alice, bob));
      await runWithLayer(graph.acceptConnection(bob, alice));
      await runWithLayer(graph.addCloseFriend(alice, bob));

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/close-friends?userId=${alice}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { closeFriendIds: string[] };
      expect(body.closeFriendIds).toContain(bob);
    });
  });

  // -------------------------------------------------------------------------
  // /graph/internal/is-close-friend
  // -------------------------------------------------------------------------

  describe("GET /graph/internal/is-close-friend", () => {
    it("returns false when not close friends", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

      const res = await app.handle(
        new Request(
          `http://localhost/graph/internal/is-close-friend?userId=${alice}&friendId=${bob}`,
          { headers: { Authorization: `ARC ${token}` } },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { isCloseFriend: boolean };
      expect(body.isCloseFriend).toBe(false);
    });

    it("returns true when close friends", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

      await runWithLayer(graph.sendConnectionRequest(alice, bob));
      await runWithLayer(graph.acceptConnection(bob, alice));
      await runWithLayer(graph.addCloseFriend(alice, bob));

      const res = await app.handle(
        new Request(
          `http://localhost/graph/internal/is-close-friend?userId=${alice}&friendId=${bob}`,
          { headers: { Authorization: `ARC ${token}` } },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { isCloseFriend: boolean };
      expect(body.isCloseFriend).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // POST /graph/internal/close-friends-of
  // -------------------------------------------------------------------------

  describe("POST /graph/internal/close-friends-of", () => {
    it("returns empty set when no one has marked viewer as close friend", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/close-friends-of", {
          method: "POST",
          headers: {
            Authorization: `ARC ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ viewerId: alice, userIds: [bob] }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { closeFriendIds: string[] };
      expect(body.closeFriendIds).toEqual([]);
    });

    it("returns IDs of users who marked viewer as close friend", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");

      // Bob adds Alice as close friend (bob → alice)
      await runWithLayer(graph.sendConnectionRequest(bob, alice));
      await runWithLayer(graph.acceptConnection(alice, bob));
      await runWithLayer(graph.addCloseFriend(bob, alice));

      // Query: which of [bob] has marked alice (viewer) as close friend?
      const res = await app.handle(
        new Request("http://localhost/graph/internal/close-friends-of", {
          method: "POST",
          headers: {
            Authorization: `ARC ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ viewerId: alice, userIds: [bob] }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { closeFriendIds: string[] };
      expect(body.closeFriendIds).toContain(bob);
    });
  });

  // -------------------------------------------------------------------------
  // POST /graph/internal/user-displays
  // -------------------------------------------------------------------------

  describe("POST /graph/internal/user-displays", () => {
    it("returns empty array for empty input", async () => {
      const { token } = await setupArcService();

      const res = await app.handle(
        new Request("http://localhost/graph/internal/user-displays", {
          method: "POST",
          headers: {
            Authorization: `ARC ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userIds: [] }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: unknown[] };
      expect(body.users).toEqual([]);
    });

    it("returns user display metadata", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/user-displays", {
          method: "POST",
          headers: {
            Authorization: `ARC ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userIds: [alice] }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        users: {
          id: string;
          handle: string;
          displayName: string | null;
          avatarUrl: string | null;
        }[];
      };
      expect(body.users).toHaveLength(1);
      expect(body.users[0].id).toBe(alice);
      expect(body.users[0].handle).toBe("alice");
    });
  });
});
