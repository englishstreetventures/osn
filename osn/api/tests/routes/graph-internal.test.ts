import { accounts, serviceAccounts, serviceAccountKeys, users } from "@osn/db/schema";
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
    // The endpoint requires the dedicated graph:resolve-account scope (S-M1
    // pulse-onboarding), granted alongside graph:read as in the real
    // pulse-api / cire-api registrations.
    const RESOLVE_SCOPES = "graph:read,graph:resolve-account";

    it("returns the accountId that owns the profile", async () => {
      const { token } = await setupArcService("pulse-api", RESOLVE_SCOPES);
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
      const { token } = await setupArcService("pulse-api", RESOLVE_SCOPES);

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

    it("rejects a token carrying only graph:read with 401 (S-M1 least privilege)", async () => {
      const { token } = await setupArcService("pulse-api", "graph:read");
      const alice = await registerProfile("alice@example.com", "alice");

      const res = await app.handle(
        new Request(`http://localhost/graph/internal/profile-account?profileId=${alice}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /graph/internal/profile-by-handle
  // -------------------------------------------------------------------------

  describe("GET /graph/internal/profile-by-handle", () => {
    it("resolves a handle to its profile id, handle, and display name", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-by-handle?handle=alice", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        profileId: string;
        handle: string;
        displayName: string | null;
      };
      expect(body.profileId).toBe(alice);
      expect(body.handle).toBe("alice");
    });

    it("strips a leading @ and folds case before resolving", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-by-handle?handle=%40Alice", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profileId: string };
      expect(body.profileId).toBe(alice);
    });

    it("returns 404 for an unknown handle", async () => {
      const { token } = await setupArcService();

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-by-handle?handle=nobody", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Profile not found");
    });

    it("returns 404 for a handle that is only an @ sigil", async () => {
      const { token } = await setupArcService();

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-by-handle?handle=%40", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(404);
    });

    it("does not resolve a soft-deleted account's handle (tombstone rule)", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");

      // Soft-delete the owning account — it must become invisible to S2S
      // resolution during the grace window, exactly like /profile-account.
      await runWithLayer(
        Effect.gen(function* () {
          const { db } = yield* Db;
          const rows = yield* Effect.tryPromise({
            try: () =>
              db.select({ accountId: users.accountId }).from(users).where(eq(users.id, alice)),
            catch: (e) => e,
          });
          const accountId = rows[0]!.accountId;
          yield* Effect.tryPromise({
            try: () =>
              db
                .update(accounts)
                .set({ deletedAt: Math.floor(Date.now() / 1000) })
                .where(eq(accounts.id, accountId)),
            catch: (e) => e,
          });
        }),
      );

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-by-handle?handle=alice", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(404);
    });

    it("rejects missing ARC token with 401", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-by-handle?handle=alice"),
      );
      expect(res.status).toBe(401);
    });

    it("rejects a token with the wrong scope with 401 (pins requireArc args on this route)", async () => {
      // The service is allowed graph:read; a graph:write token must be rejected.
      // Asserted directly on /profile-by-handle so a fat-fingered scope constant
      // on this route is caught even though the guard is shared.
      const { keyPair: kp, keyId } = await setupArcService("pulse-api", "graph:read", "osn-api");
      const badToken = await createArcToken(kp.privateKey, {
        iss: "pulse-api",
        aud: "osn-api",
        scope: "graph:write",
        kid: keyId,
      });
      await registerProfile("alice@example.com", "alice");
      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-by-handle?handle=alice", {
          headers: { Authorization: `ARC ${badToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("rejects a token with the wrong audience with 401", async () => {
      const { keyPair: kp, keyId } = await setupArcService("pulse-api", "graph:read", "osn-api");
      const badToken = await createArcToken(kp.privateKey, {
        iss: "pulse-api",
        aud: "wrong-service",
        scope: "graph:read",
        kid: keyId,
      });
      await registerProfile("alice@example.com", "alice");
      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-by-handle?handle=alice", {
          headers: { Authorization: `ARC ${badToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /graph/internal/profile-search  (co-host autocomplete)
  // -------------------------------------------------------------------------

  describe("GET /graph/internal/profile-search", () => {
    it("returns profiles whose handle starts with the prefix, ordered by handle", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const alina = await registerProfile("alina@example.com", "alina");
      await registerProfile("bob@example.com", "bob");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=al", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: { id: string; handle: string }[] };
      // Both al* handles match, bob is excluded, ordered alphabetically by handle
      // ("alice" < "alina").
      expect(body.profiles.map((p) => p.handle)).toEqual(["alice", "alina"]);
      expect(body.profiles.map((p) => p.id)).toEqual([alice, alina]);
    });

    it("strips a leading @ and folds case before matching", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=%40AL", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: { id: string }[] };
      expect(body.profiles.map((p) => p.id)).toContain(alice);
    });

    it("returns an empty list (not an error) for a prefix below the minimum length", async () => {
      const { token } = await setupArcService();
      await registerProfile("alice@example.com", "alice");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=a", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: unknown[] };
      expect(body.profiles).toEqual([]);
    });

    it("returns an empty list for a prefix that is only an @ sigil", async () => {
      const { token } = await setupArcService();
      await registerProfile("alice@example.com", "alice");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=%40", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: unknown[] };
      expect(body.profiles).toEqual([]);
    });

    it("does not return matches from soft-deleted accounts (tombstone rule)", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      await registerProfile("alina@example.com", "alina");

      // Soft-delete alice's account — it must drop out of search results.
      await runWithLayer(
        Effect.gen(function* () {
          const { db } = yield* Db;
          const rows = yield* Effect.tryPromise({
            try: () =>
              db.select({ accountId: users.accountId }).from(users).where(eq(users.id, alice)),
            catch: (e) => e,
          });
          const accountId = rows[0]!.accountId;
          yield* Effect.tryPromise({
            try: () =>
              db
                .update(accounts)
                .set({ deletedAt: Math.floor(Date.now() / 1000) })
                .where(eq(accounts.id, accountId)),
            catch: (e) => e,
          });
        }),
      );

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=al", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: { handle: string }[] };
      expect(body.profiles.map((p) => p.handle)).toEqual(["alina"]);
    });

    it("caps the result count at the hard maximum (10) even when limit is larger", async () => {
      const { token } = await setupArcService();
      // 12 handles sharing the "user" prefix — more than the hard cap.
      for (let i = 0; i < 12; i++) {
        const n = String(i).padStart(2, "0");
        // eslint-disable-next-line no-await-in-loop -- sequential seeding
        await registerProfile(`user${n}@example.com`, `user${n}`);
      }

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=user&limit=50", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: unknown[] };
      expect(body.profiles).toHaveLength(10);
    });

    it("honours a smaller explicit limit", async () => {
      const { token } = await setupArcService();
      await registerProfile("sam@example.com", "sam");
      await registerProfile("samuel@example.com", "samuel");
      await registerProfile("samantha@example.com", "samantha");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=sam&limit=2", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: unknown[] };
      expect(body.profiles).toHaveLength(2);
    });

    it("rejects a missing ARC token with 401", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=al"),
      );
      expect(res.status).toBe(401);
    });

    it("rejects a token with the wrong scope with 401", async () => {
      const { keyPair: kp, keyId } = await setupArcService("pulse-api", "graph:read", "osn-api");
      const badToken = await createArcToken(kp.privateKey, {
        iss: "pulse-api",
        aud: "osn-api",
        scope: "graph:write",
        kid: keyId,
      });
      await registerProfile("alice@example.com", "alice");
      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=al", {
          headers: { Authorization: `ARC ${badToken}` },
        }),
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
      // The secret is now threaded into the factory (not read from process.env
      // inside the handler), so rebuild the app with it set for this block.
      app = createInternalGraphRoutes(layer, undefined, SECRET);
      // S-M1 requires a genuinely importable JWK — generate a real key pair.
      const kp = await generateArcKeyPair();
      validBody = {
        serviceId: "zap-api",
        keyId: "key-reg-1",
        publicKeyJwk: await exportKeyToJwk(kp.publicKey),
        allowedScopes: "graph:read",
      };
    });

    it("returns 501 when INTERNAL_SERVICE_SECRET is unset", async () => {
      // Build with the secret undefined — the endpoint must answer 501.
      const unconfigured = createInternalGraphRoutes(layer, undefined, undefined);
      const res = await unconfigured.handle(
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
  // Bug A: workerd has no `crypto.timingSafeEqual` on the GLOBAL (Web Crypto)
  // object. The secret-bearer compare must use a workerd-safe constant-time
  // equality (node:crypto) so `/register-service` + `/service-keys/:keyId`
  // never 500 on the live Worker. These tests simulate workerd by removing
  // `timingSafeEqual` from the global `crypto` for their duration.
  // -------------------------------------------------------------------------
  describe("Bug A: workerd-safe secret compare (no global crypto.timingSafeEqual)", () => {
    const SECRET = "test-internal-secret";
    beforeEach(() => {
      app = createInternalGraphRoutes(layer, undefined, SECRET);
      // Simulate workerd: the global Web Crypto exposes no timingSafeEqual.
      // In Bun it lives on the Crypto prototype, so shadow it on the instance
      // with `undefined` (configurable so afterEach can remove the shadow).
      Object.defineProperty(globalThis.crypto, "timingSafeEqual", {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      // Remove the instance-level shadow so the prototype method is visible
      // again to the rest of the suite.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis.crypto as any).timingSafeEqual;
    });

    it("register-service: wrong secret returns 401, never throws (no global timingSafeEqual)", async () => {
      const res = await app.handle(
        new Request("http://localhost/graph/internal/register-service", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-secret" },
          body: JSON.stringify({
            serviceId: "cire-api",
            keyId: "key-bug-a-1",
            publicKeyJwk: "{}",
            allowedScopes: "graph:read",
          }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it("register-service: valid secret proceeds (200) without global timingSafeEqual", async () => {
      const kp = await generateArcKeyPair();
      const res = await app.handle(
        new Request("http://localhost/graph/internal/register-service", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({
            serviceId: "cire-api",
            keyId: "key-bug-a-2",
            publicKeyJwk: await exportKeyToJwk(kp.publicKey),
            allowedScopes: "graph:read",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("service-keys delete: valid secret returns 200 without global timingSafeEqual", async () => {
      const { keyId } = await setupArcService("bug-a-del-svc", "graph:read");
      const res = await app.handle(
        new Request(`http://localhost/graph/internal/service-keys/${keyId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${SECRET}` },
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /graph/internal/service-keys/:keyId  (T-R2)
  // -------------------------------------------------------------------------

  describe("DELETE /graph/internal/service-keys/:keyId", () => {
    const SECRET = "test-internal-secret";

    beforeEach(() => {
      // Secret threaded into the factory — rebuild with it set for this block.
      app = createInternalGraphRoutes(layer, undefined, SECRET);
    });

    it("returns 501 when INTERNAL_SERVICE_SECRET is unset", async () => {
      const unconfigured = createInternalGraphRoutes(layer, undefined, undefined);
      const res = await unconfigured.handle(
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
