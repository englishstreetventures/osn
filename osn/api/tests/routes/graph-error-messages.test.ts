/**
 * Regression tests for the graph routes' error contract.
 *
 * Route handlers run service effects through `ManagedRuntime.runPromise`,
 * which rejects with a `FiberFailure` — not the tagged error itself. Before
 * `makeSafeError`, that meant every business-rule failure ("Connection
 * already exists", "Cannot connect to yourself", …) reached clients as the
 * generic "Request failed", which is exactly what users saw in the social
 * app when a Connect click hit an already-pending edge.
 */

import type { Db } from "@osn/db/service";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createGraphRoutes } from "../../src/routes/graph";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("graph route error messages", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let graphApp: ReturnType<typeof createGraphRoutes>;
  let auth: ReturnType<typeof createAuthService>;

  beforeEach(() => {
    layer = createTestLayer();
    graphApp = createGraphRoutes(config, layer);
    auth = createAuthService(config);
  });

  const runWithLayer = <A>(eff: Effect.Effect<A, unknown, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

  async function registerAndGetToken(email: string, handle: string) {
    const user = await runWithLayer(auth.registerProfile(email, handle));
    const tokens = await runWithLayer(
      auth.issueTokens(user.id, user.accountId, user.email, user.handle, user.displayName),
    );
    return { profileId: user.id, token: tokens.accessToken };
  }

  const post = (path: string, token: string) =>
    graphApp.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

  const patch = (path: string, token: string, body: unknown) =>
    graphApp.handle(
      new Request(`http://localhost${path}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("duplicate connection request → 400 'Connection already exists'", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    expect((await post("/graph/connections/bob", alice.token)).status).toBe(201);

    const res = await post("/graph/connections/bob", alice.token);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Connection already exists");
  });

  it("connecting to yourself → 400 'Cannot connect to yourself'", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");

    const res = await post("/graph/connections/alice", alice.token);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Cannot connect to yourself");
  });

  it("connecting to someone who blocked you → 400 'Cannot send connection request'", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    expect((await post("/graph/blocks/alice", bob.token)).status).toBe(201);

    const res = await post("/graph/connections/bob", alice.token);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Cannot send connection request");
  });

  it("accepting a non-existent request → 400 'Pending request not found'", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    const res = await patch("/graph/connections/bob", alice.token, { action: "accept" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Pending request not found");
  });

  it("a DatabaseError still collapses to 'Request failed' — DB internals never leak (S-M17)", async () => {
    const { layer: brokenLayer, sqlite } = createTestLayerWithSqlite();
    const brokenApp = createGraphRoutes(config, brokenLayer);
    const brokenRun = <A>(eff: Effect.Effect<A, unknown, Db>): Promise<A> =>
      Effect.runPromise(eff.pipe(Effect.provide(brokenLayer)) as Effect.Effect<A, never, never>);

    const user = await brokenRun(auth.registerProfile("alice@example.com", "alice"));
    await brokenRun(auth.registerProfile("bob@example.com", "bob"));
    const tokens = await brokenRun(
      auth.issueTokens(user.id, user.accountId, user.email, user.handle, user.displayName),
    );

    // Break the graph tables underneath the service so the send path fails
    // with a DatabaseError rather than a tagged business-rule error.
    sqlite.run("DROP TABLE connections");

    const res = await brokenApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
    expect(res.status).toBe(400);
    const raw = await res.text();
    const body = JSON.parse(raw) as { error?: string };
    expect(body.error).toBe("Request failed");
    // The SQLite failure detail must never reach the client.
    expect(raw).not.toContain("no such table");
    expect(raw).not.toContain("SQLITE");
  });

  it("POST with Content-Type: application/json and no body (GraphClient's shape) still succeeds", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    const res = await graphApp.handle(
      new Request("http://localhost/graph/connections/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(201);
  });
});
