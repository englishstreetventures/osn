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

import { osnLoggerLayer } from "../../src/observability";
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
  // Fallback runtime with an observability layer (S-L30)
  // -------------------------------------------------------------------------

  // The fix threads a logger layer into the FALLBACK runtime — the path
  // production never takes, since it always passes the shared `appRuntime`.
  // That is exactly why the gap sat unnoticed, and why leaving the branch
  // untested would reproduce it. A layer graph that fails to build, or a merge
  // that shadows the DB layer, shows up as a request failure rather than as a
  // subtle difference in log output — so a plain status assertion is enough
  // and avoids coupling the test to log formatting.
  describe("fallback runtime with a logger layer", () => {
    it("serves an ARC-authed request under the merged db + logger layer", async () => {
      const { token } = await setupArcService();
      const withLogger = createInternalGraphRoutes(layer, undefined, undefined, osnLoggerLayer);

      const res = await withLogger.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );

      expect(res.status).toBe(200);
    });

    it("still fails closed with no ARC token", async () => {
      // The error path is where a handler would actually log.
      const withLogger = createInternalGraphRoutes(layer, undefined, undefined, osnLoggerLayer);

      const res = await withLogger.handle(
        new Request("http://localhost/graph/internal/either-blocked?profileA=a&profileB=b"),
      );

      expect(res.status).toBe(401);
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

    it("strips the @ even when the query is padded with whitespace", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");

      // Regression: the old local normaliser tested `startsWith("@")` BEFORE
      // trimming, so a leading space (what a paste or a mobile keyboard's
      // auto-space produces) left the sigil in place and matched nothing.
      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=%20%40al%20", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: { id: string }[] };
      expect(body.profiles.map((p) => p.id)).toContain(alice);
    });

    it("treats `_` in the prefix literally rather than as a LIKE wildcard", async () => {
      const { token } = await setupArcService();
      await registerProfile("u1@example.com", "b_ob");
      await registerProfile("u2@example.com", "brob");

      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=b_o", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: { handle: string }[] };
      // "brob" would match if `_` were a single-char wildcard.
      expect(body.profiles.map((p) => p.handle)).toEqual(["b_ob"]);
    });

    it("gets the range's EXCLUSIVE upper bound right at the boundary", async () => {
      const { token } = await setupArcService();
      const user1 = await registerProfile("u1@example.com", "user1");
      const user19 = await registerProfile("u19@example.com", "user19");
      await registerProfile("u2@example.com", "user2");

      // `user1` → range ["user1", "user2"). The half-open bound must include
      // "user1" itself and everything extending it, and exclude "user2". Only
      // a real query can catch a divergence between JS `<` and SQLite's BINARY
      // collation — the unit test in @shared/db-utils re-implements the
      // comparison in JS, which is not the same proof.
      const res = await app.handle(
        new Request("http://localhost/graph/internal/profile-search?prefix=user1", {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profiles: { id: string; handle: string }[] };
      expect(body.profiles.map((p) => p.handle)).toEqual(["user1", "user19"]);
      expect(body.profiles.map((p) => p.id)).toEqual([user1, user19]);
    });

    it("returns an empty list for a prefix no handle could contain", async () => {
      const { token } = await setupArcService();
      await registerProfile("alice@example.com", "alice");

      // Handles are `^[a-z0-9_]+$`, so a query with a space, a dot or a `%`
      // cannot prefix one — the route skips the query rather than scanning.
      for (const prefix of ["al%25", "al.ice", "al%20ice"]) {
        // eslint-disable-next-line no-await-in-loop -- sequential assertions
        const res = await app.handle(
          new Request(`http://localhost/graph/internal/profile-search?prefix=${prefix}`, {
            headers: { Authorization: `ARC ${token}` },
          }),
        );
        expect(res.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop -- sequential assertions
        const body = (await res.json()) as { profiles: unknown[] };
        expect(body.profiles).toEqual([]);
      }
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
  // GET /graph/internal/connection-search  (co-host autocomplete, own graph)
  // -------------------------------------------------------------------------

  describe("GET /graph/internal/connection-search", () => {
    /** Set a profile's display name — registerProfile leaves it unset. */
    async function setDisplayName(profileId: string, displayName: string): Promise<void> {
      await runWithLayer(
        Effect.gen(function* () {
          const { db } = yield* Db;
          yield* Effect.tryPromise({
            try: () => db.update(users).set({ displayName }).where(eq(users.id, profileId)),
            catch: (e) => e,
          });
        }),
      );
    }

    /** Establish an accepted connection between two profiles. */
    async function connect(a: string, b: string): Promise<void> {
      await runWithLayer(graph.sendConnectionRequest(a, b));
      await runWithLayer(graph.acceptConnection(b, a));
    }

    const search = async (token: string, qs: string) =>
      app.handle(
        new Request(`http://localhost/graph/internal/connection-search?${qs}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );

    const handlesOf = async (res: Response) => {
      const body = (await res.json()) as { profiles: { handle: string }[] };
      return body.profiles.map((p) => p.handle);
    };

    it("returns the viewer's accepted connections when the query is empty", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      const zoe = await registerProfile("zoe@example.com", "zoe");
      await connect(alice, bob);
      await connect(alice, zoe);

      const res = await search(token, `profileId=${alice}&q=`);
      expect(res.status).toBe(200);
      // Ordered by handle, both directions of the pair resolved to the peer.
      expect(await handlesOf(res)).toEqual(["bob", "zoe"]);
    });

    it("returns connections when `q` is omitted entirely", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      await connect(alice, bob);

      const res = await search(token, `profileId=${alice}`);
      expect(res.status).toBe(200);
      expect(await handlesOf(res)).toEqual(["bob"]);
    });

    it("resolves the peer regardless of who requested the connection", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      // bob is the REQUESTER here — alice must still see bob, not herself.
      await connect(bob, alice);

      const res = await search(token, `profileId=${alice}`);
      expect(await handlesOf(res)).toEqual(["bob"]);
    });

    it("filters by handle prefix", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      const bella = await registerProfile("bella@example.com", "bella");
      const zoe = await registerProfile("zoe@example.com", "zoe");
      await connect(alice, bob);
      await connect(alice, bella);
      await connect(alice, zoe);

      const res = await search(token, `profileId=${alice}&q=be`);
      expect(await handlesOf(res)).toEqual(["bella"]);
    });

    it("matches a display-name substring, not just a handle prefix", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const pk = await registerProfile("priya@example.com", "pk_1994");
      await setDisplayName(pk, "Anaya Priyadarshini");
      await connect(alice, pk);

      // "priya" is neither a prefix of the handle nor of the display name.
      const res = await search(token, `profileId=${alice}&q=priya`);
      const body = (await res.json()) as { profiles: unknown[] };
      // Assert the WHOLE row, not just the handle: this is the exact shape
      // cire's ARC bridge parses, and a dropped column would otherwise be
      // invisible here and degrade silently to nameless suggestions there.
      expect(body.profiles).toEqual([
        { id: pk, handle: "pk_1994", displayName: "Anaya Priyadarshini", avatarUrl: null },
      ]);
    });

    it("escapes LIKE wildcards on the display-name arm", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const rao = await registerProfile("rao@example.com", "arao");
      await setDisplayName(rao, "Alina Rao");
      await connect(alice, rao);

      // `a%o` holds a character no handle can contain, so the prefix range is
      // null and ONLY the display-name LIKE runs — the one production call site
      // in this endpoint where the escaping matters. Unescaped, `%a%o%` would
      // match "Alina Rao".
      expect(await handlesOf(await search(token, `profileId=${alice}&q=a%25o`))).toEqual([]);
      // Control: the same row IS reachable by a literal substring.
      expect(await handlesOf(await search(token, `profileId=${alice}&q=rao`))).toEqual(["arao"]);
    });

    it("strips a leading @ and folds case before matching", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      await connect(alice, bob);

      const res = await search(token, `profileId=${alice}&q=%40BO`);
      expect(await handlesOf(res)).toEqual(["bob"]);
    });

    it("accepts a single character — there is no minimum-length floor here", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      await connect(alice, bob);

      // The floor on /profile-search exists to stop namespace enumeration; a
      // single accepted-connection list has no namespace to enumerate.
      const res = await search(token, `profileId=${alice}&q=b`);
      expect(await handlesOf(res)).toEqual(["bob"]);
    });

    it("treats `_` in the query literally rather than as a LIKE wildcard", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const underscore = await registerProfile("u1@example.com", "b_ob");
      const plain = await registerProfile("u2@example.com", "brob");
      await connect(alice, underscore);
      await connect(alice, plain);

      const res = await search(token, `profileId=${alice}&q=b_o`);
      // "brob" would match if `_` were a single-char wildcard.
      expect(await handlesOf(res)).toEqual(["b_ob"]);
    });

    it("excludes pending (not yet accepted) connection requests", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      // Requested but never accepted — not a connection, and surfacing it would
      // leak that a request is in flight.
      await runWithLayer(graph.sendConnectionRequest(alice, bob));

      const res = await search(token, `profileId=${alice}`);
      expect(await handlesOf(res)).toEqual([]);
    });

    it("returns an empty list for a profile with no connections", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      await registerProfile("bob@example.com", "bob");

      const res = await search(token, `profileId=${alice}`);
      expect(res.status).toBe(200);
      expect(await handlesOf(res)).toEqual([]);
    });

    it("does not leak another profile's connections into the viewer's list", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      const carol = await registerProfile("carol@example.com", "carol");
      // bob↔carol are connected; alice is connected to neither.
      await connect(bob, carol);

      const res = await search(token, `profileId=${alice}`);
      expect(await handlesOf(res)).toEqual([]);
    });

    it("does not return connections whose account is soft-deleted (tombstone rule)", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      const zoe = await registerProfile("zoe@example.com", "zoe");
      await connect(alice, bob);
      await connect(alice, zoe);

      await runWithLayer(
        Effect.gen(function* () {
          const { db } = yield* Db;
          const rows = yield* Effect.tryPromise({
            try: () =>
              db.select({ accountId: users.accountId }).from(users).where(eq(users.id, bob)),
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

      const res = await search(token, `profileId=${alice}`);
      expect(await handlesOf(res)).toEqual(["zoe"]);
    });

    it("drops a connection once one side blocks the other", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      await connect(alice, bob);
      // Blocking deletes the connection row, so no separate block filter is
      // needed for a blocked pair to disappear from suggestions.
      await runWithLayer(graph.blockProfile(bob, alice));

      const res = await search(token, `profileId=${alice}`);
      expect(await handlesOf(res)).toEqual([]);
    });

    it("caps the result count at the hard maximum (10) even when limit is larger", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      for (let i = 0; i < 12; i++) {
        const n = String(i).padStart(2, "0");
        // eslint-disable-next-line no-await-in-loop -- sequential seeding
        const peer = await registerProfile(`user${n}@example.com`, `user${n}`);
        // eslint-disable-next-line no-await-in-loop -- sequential seeding
        await connect(alice, peer);
      }

      const res = await search(token, `profileId=${alice}&limit=50`);
      const body = (await res.json()) as { profiles: unknown[] };
      expect(body.profiles).toHaveLength(10);
    });

    it("honours a smaller explicit limit", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      const carol = await registerProfile("carol@example.com", "carol");
      await connect(alice, bob);
      await connect(alice, carol);

      const res = await search(token, `profileId=${alice}&limit=1`);
      const body = (await res.json()) as { profiles: unknown[] };
      expect(body.profiles).toHaveLength(1);
    });

    it("returns an empty list (never a 4xx) for a query past the length guard", async () => {
      const { token } = await setupArcService();
      const alice = await registerProfile("alice@example.com", "alice");
      const bob = await registerProfile("bob@example.com", "bob");
      // A display name long enough that an over-long query CAN legitimately
      // match a substring of it. Without this the assertion would hold whether
      // or not the guard existed — handles cap at 30 characters, so any long
      // query returns nothing anyway, and the test would prove nothing.
      await setDisplayName(bob, `Bartholomew ${"o".repeat(100)}`);
      await connect(alice, bob);

      // 70 chars — past MAX_CONNECTION_QUERY_LEN (64), so the guard fires
      // before any LIKE pattern is built.
      const over = await search(token, `profileId=${alice}&q=${"o".repeat(70)}`);
      // Degrades to "no suggestions" rather than an error the caller must
      // special-case — every failure on an autocomplete path should.
      expect(over.status).toBe(200);
      expect(await handlesOf(over)).toEqual([]);

      // 60 chars — inside the guard, and a real substring of that display
      // name. This is the half that makes the guard the only difference
      // between the two outcomes.
      const under = await search(token, `profileId=${alice}&q=${"o".repeat(60)}`);
      expect(await handlesOf(under)).toEqual(["bob"]);
    });

    it("returns 401 without an ARC token", async () => {
      const alice = await registerProfile("alice@example.com", "alice");
      const res = await app.handle(
        new Request(`http://localhost/graph/internal/connection-search?profileId=${alice}`),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 for a token without graph:read scope", async () => {
      const { token } = await setupArcService("pulse-api", "account:erase");
      const alice = await registerProfile("alice@example.com", "alice");
      const res = await search(token, `profileId=${alice}`);
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

    it("accepts org:read scope (needed for cire-api org-membership resolvers)", async () => {
      // T-R3: org:read must be in PERMITTED_SCOPES so the registration curl in
      // the §6.2 runbook can widen cire-api's grant to include org:read.
      const res = await app.handle(
        new Request("http://localhost/graph/internal/register-service", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SECRET}`,
          },
          body: JSON.stringify({
            ...validBody,
            keyId: "key-org-read-1",
            allowedScopes: "graph:read,graph:resolve-account,org:read",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
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
