import type { Db } from "@osn/db/service";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { describe, it, expect, beforeEach } from "vitest";

import { createAuthRoutes } from "../../src/routes/auth";
import { createGraphRoutes } from "../../src/routes/graph";
import { createAuthService } from "../../src/services/auth";
import { createTestLayer } from "../helpers/db";

const config = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  jwtSecret: "test-secret-at-least-32-characters-long",
};

describe("graph routes", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let authApp: ReturnType<typeof createAuthRoutes>;
  let graphApp: ReturnType<typeof createGraphRoutes>;
  let auth: ReturnType<typeof createAuthService>;

  beforeEach(() => {
    layer = createTestLayer();
    authApp = createAuthRoutes(config, layer);
    graphApp = createGraphRoutes(config, layer);
    auth = createAuthService(config);
  });

  const runWithLayer = <A>(eff: Effect.Effect<A, unknown, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

  /** Register a user and return a valid access token for them. */
  async function registerAndGetToken(
    email: string,
    handle: string,
  ): Promise<{ profileId: string; token: string }> {
    const user = await runWithLayer(auth.registerProfile(email, handle));
    const tokens = await runWithLayer(
      auth.issueTokens(user.id, user.accountId, user.email, user.handle, user.displayName),
    );
    return { profileId: user.id, token: tokens.accessToken };
  }

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------

  it("returns 401 without token on POST /graph/connections/:handle", async () => {
    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: "Bearer not-a-valid-token" },
      }),
    );
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Connection flow
  // -------------------------------------------------------------------------

  it("POST /graph/connections/:handle → 201 sends a request", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("GET /graph/connections/:handle returns pending_sent after request", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("pending_sent");
  });

  it("PATCH /graph/connections/:handle accept → connected", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );
    expect(res.status).toBe(200);

    const statusRes = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await statusRes.json()) as { status: string };
    expect(json.status).toBe("connected");
  });

  it("GET /graph/connections lists connected peers", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { connections: { handle: string }[] };
    expect(json.connections).toHaveLength(1);
    expect(json.connections[0].handle).toBe("bob");
  });

  it("GET /graph/connections/pending lists incoming requests", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/pending", {
        headers: { Authorization: `Bearer ${bob.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pending: { handle: string }[] };
    expect(json.pending).toHaveLength(1);
    expect(json.pending[0].handle).toBe("alice");
  });

  it("DELETE /graph/connections/:handle removes connection", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);

    const statusRes = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await statusRes.json()) as { status: string };
    expect(json.status).toBe("none");
  });

  it("DELETE /graph/connections/:handle also cleans up close friends", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    // Connect
    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );

    // Add close friend
    await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    // Remove connection
    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    // Close friend should be gone
    const listRes = await graphApp.handle(
      new Request("http://localhost/graph/close-friends", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await listRes.json()) as { closeFriends: unknown[] };
    expect(json.closeFriends).toHaveLength(0);
  });

  it("POST /graph/connections/:handle → 404 for unknown handle", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/nobody", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(404);
    void authApp;
  });

  // -------------------------------------------------------------------------
  // Close friends
  // -------------------------------------------------------------------------

  it("PATCH /graph/connections/:handle reject → none", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "reject" }),
      }),
    );
    expect(res.status).toBe(200);

    const statusRes = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await statusRes.json()) as { status: string };
    expect(json.status).toBe("none");
  });

  it("POST /graph/close-friends/:handle → 201 after connecting", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    // Connect first
    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(201);
  });

  it("POST /graph/close-friends/:handle → 400 if not connected", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    const res = await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET /graph/close-friends lists close friends", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/close-friends", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await res.json()) as { closeFriends: { handle: string }[] };
    expect(json.closeFriends).toHaveLength(1);
    expect(json.closeFriends[0].handle).toBe("bob");
  });

  // -------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------

  it("DELETE /graph/close-friends/:handle removes from list", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    // Connect and add as close friend
    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);

    const listRes = await graphApp.handle(
      new Request("http://localhost/graph/close-friends", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await listRes.json()) as { closeFriends: unknown[] };
    expect(json.closeFriends).toHaveLength(0);
  });

  it("GET /graph/close-friends/:handle returns true when marked", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    // Connect and add as close friend
    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { isCloseFriend: boolean };
    expect(json.isCloseFriend).toBe(true);
  });

  it("GET /graph/close-friends/:handle returns false when not marked", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    const res = await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { isCloseFriend: boolean };
    expect(json.isCloseFriend).toBe(false);
  });

  it("GET /graph/close-friends/:handle → 404 for unknown handle", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const res = await graphApp.handle(
      new Request("http://localhost/graph/close-friends/nobody", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("GET /graph/close-friends/:handle → 401 without auth", async () => {
    const res = await graphApp.handle(new Request("http://localhost/graph/close-friends/bob"));
    expect(res.status).toBe(401);
  });

  it("DELETE /graph/close-friends/:handle → 400 if not in list", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    const res = await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST /graph/blocks/:handle → 201 blocks a user", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    const res = await graphApp.handle(
      new Request("http://localhost/graph/blocks/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(201);
  });

  it("DELETE /graph/blocks/:handle unblocks", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/blocks/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const res = await graphApp.handle(
      new Request("http://localhost/graph/blocks/bob", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("GET /graph/blocks lists blocked users", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/blocks/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/blocks", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await res.json()) as { blocks: { handle: string }[] };
    expect(json.blocks).toHaveLength(1);
    expect(json.blocks[0].handle).toBe("bob");
  });

  // -------------------------------------------------------------------------
  // Routing: static "pending" segment must not be swallowed by /:handle
  // -------------------------------------------------------------------------

  it("GET /graph/connections/pending is not confused with handle 'pending'", async () => {
    // Register a user whose handle is literally "pending"
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const pending = await registerAndGetToken("pending@example.com", "pending");

    // Alice sends a request to the user called "pending"
    await graphApp.handle(
      new Request("http://localhost/graph/connections/pending", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    // GET /graph/connections/pending from pending's perspective should return
    // the incoming request list (alice), not a status check for handle "pending"
    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/pending", {
        headers: { Authorization: `Bearer ${pending.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pending: { handle: string }[] };
    // This should be the pending-requests list, not a status object
    expect(Array.isArray(json.pending)).toBe(true);
    expect(json.pending[0].handle).toBe("alice");
  });

  it("GET /graph/close-friends returns list, not status check for handle", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    // Connect and add as close friend
    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    // GET /graph/close-friends should return the list format
    const listRes = await graphApp.handle(
      new Request("http://localhost/graph/close-friends", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { closeFriends: { handle: string }[] };
    expect(Array.isArray(listJson.closeFriends)).toBe(true);
    expect(listJson.closeFriends[0].handle).toBe("bob");

    // GET /graph/close-friends/bob should return the status check format
    const statusRes = await graphApp.handle(
      new Request("http://localhost/graph/close-friends/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as { isCloseFriend: boolean };
    expect(statusJson.isCloseFriend).toBe(true);
  });

  // -------------------------------------------------------------------------
  // isBlocked
  // -------------------------------------------------------------------------

  it("GET /graph/is-blocked/:handle returns false when no block", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    const res = await graphApp.handle(
      new Request("http://localhost/graph/is-blocked/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { blocked: boolean };
    expect(json.blocked).toBe(false);
  });

  it("GET /graph/is-blocked/:handle returns true when caller blocked target", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    await graphApp.handle(
      new Request("http://localhost/graph/blocks/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    const res = await graphApp.handle(
      new Request("http://localhost/graph/is-blocked/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await res.json()) as { blocked: boolean };
    expect(json.blocked).toBe(true);
  });

  it("GET /graph/is-blocked/:handle returns false when only target has blocked caller (M1: one-directional)", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    // Bob blocks alice — but alice has NOT blocked bob
    await graphApp.handle(
      new Request("http://localhost/graph/blocks/alice", {
        method: "POST",
        headers: { Authorization: `Bearer ${bob.token}` },
      }),
    );

    // Alice queries is-blocked/bob → false: she has not blocked him
    const res = await graphApp.handle(
      new Request("http://localhost/graph/is-blocked/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await res.json()) as { blocked: boolean };
    expect(json.blocked).toBe(false);
  });

  it("block removes existing connection", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    // Connect first
    await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    await graphApp.handle(
      new Request("http://localhost/graph/connections/alice", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );

    // Block
    await graphApp.handle(
      new Request("http://localhost/graph/blocks/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    // Connection should be gone
    const statusRes = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const json = (await statusRes.json()) as { status: string };
    expect(json.status).toBe("none");
  });

  // -------------------------------------------------------------------------
  // Rate limiter dependency injection (Phase 1 of Redis migration)
  // -------------------------------------------------------------------------
  describe("rate limiter dependency injection", () => {
    it("uses the injected rate limiter on write operations", async () => {
      const rejectAll: RateLimiterBackend = { check: () => false };
      const freshGraph = createGraphRoutes(config, layer, Layer.empty, rejectAll);
      const alice = await registerAndGetToken("alice@example.com", "alice");
      await registerAndGetToken("bob@example.com", "bob");

      const res = await freshGraph.handle(
        new Request("http://localhost/graph/connections/bob", {
          method: "POST",
          headers: { Authorization: `Bearer ${alice.token}` },
        }),
      );
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Too many requests");
    });

    it("supports async rate limiter backends", async () => {
      const asyncReject: RateLimiterBackend = {
        check: () => Promise.resolve(false),
      };
      const freshGraph = createGraphRoutes(config, layer, Layer.empty, asyncReject);
      const alice = await registerAndGetToken("alice@example.com", "alice");
      await registerAndGetToken("bob@example.com", "bob");

      const res = await freshGraph.handle(
        new Request("http://localhost/graph/close-friends/bob", {
          method: "POST",
          headers: { Authorization: `Bearer ${alice.token}` },
        }),
      );
      expect(res.status).toBe(429);
    });

    it("fails closed when the backend rejects (S-M1)", async () => {
      const failing: RateLimiterBackend = {
        check: () => Promise.reject(new Error("Redis connection refused")),
      };
      const freshGraph = createGraphRoutes(config, layer, Layer.empty, failing);
      const alice = await registerAndGetToken("alice@example.com", "alice");
      await registerAndGetToken("bob@example.com", "bob");

      const res = await freshGraph.handle(
        new Request("http://localhost/graph/connections/bob", {
          method: "POST",
          headers: { Authorization: `Bearer ${alice.token}` },
        }),
      );
      // Must return 429 (fail-closed), not 500 (unhandled rejection).
      expect(res.status).toBe(429);
    });

    it("does not rate-limit read operations", async () => {
      const rejectAll: RateLimiterBackend = { check: () => false };
      const freshGraph = createGraphRoutes(config, layer, Layer.empty, rejectAll);
      const alice = await registerAndGetToken("alice@example.com", "alice");

      // GET /connections is a read — should not hit the rate limiter
      const res = await freshGraph.handle(
        new Request("http://localhost/graph/connections", {
          headers: { Authorization: `Bearer ${alice.token}` },
        }),
      );
      expect(res.status).toBe(200);
    });
  });
});
