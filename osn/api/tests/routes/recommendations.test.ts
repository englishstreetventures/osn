import type { Db } from "@osn/db/service";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createGraphRoutes } from "../../src/routes/graph";
import { createRecommendationRoutes } from "../../src/routes/recommendations";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("recommendations routes", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let recsApp: ReturnType<typeof createRecommendationRoutes>;
  let graphApp: ReturnType<typeof createGraphRoutes>;
  let auth: ReturnType<typeof createAuthService>;

  beforeEach(() => {
    layer = createTestLayer();
    recsApp = createRecommendationRoutes(config, layer);
    graphApp = createGraphRoutes(config, layer);
    auth = createAuthService(config);
  });

  const runWithLayer = <A>(eff: Effect.Effect<A, unknown, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

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

  /** Bidirectionally connect two profiles via the graph routes. */
  async function connect(tokenA: string, handleB: string, tokenB: string, handleA: string) {
    await graphApp.handle(
      new Request(`http://localhost/graph/connections/${handleB}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}` },
      }),
    );
    await graphApp.handle(
      new Request(`http://localhost/graph/connections/${handleA}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "accept" }),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------

  it("returns 401 without token", async () => {
    const res = await recsApp.handle(new Request("http://localhost/recommendations/connections"));
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await recsApp.handle(
      new Request("http://localhost/recommendations/connections", {
        headers: { Authorization: "Bearer not-a-valid-token" },
      }),
    );
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("returns [] when the caller has no connections", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const res = await recsApp.handle(
      new Request("http://localhost/recommendations/connections", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { suggestions: unknown[] };
    expect(json.suggestions).toEqual([]);
  });

  it("returns FOF suggestions with mutual counts", async () => {
    const alice = await registerAndGetToken("a@e.com", "alice");
    const bob = await registerAndGetToken("b@e.com", "bob");
    const dana = await registerAndGetToken("d@e.com", "dana");
    await connect(alice.token, "bob", bob.token, "alice");
    await connect(bob.token, "dana", dana.token, "bob");

    const res = await recsApp.handle(
      new Request("http://localhost/recommendations/connections", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      suggestions: Array<{ handle: string; mutualCount: number }>;
    };
    expect(json.suggestions).toHaveLength(1);
    expect(json.suggestions[0]!.handle).toBe("dana");
    expect(json.suggestions[0]!.mutualCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Limit parsing (T-S1)
  // -------------------------------------------------------------------------

  it("accepts a numeric ?limit query param", async () => {
    const alice = await registerAndGetToken("a@e.com", "alice");
    const res = await recsApp.handle(
      new Request("http://localhost/recommendations/connections?limit=5", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a non-numeric ?limit at the HTTP boundary (S-M1/P-W1)", async () => {
    // With t.Numeric in the schema, Elysia returns 422 for non-numeric
    // input rather than silently collapsing to an empty result.
    const alice = await registerAndGetToken("a@e.com", "alice");

    const res = await recsApp.handle(
      new Request("http://localhost/recommendations/connections?limit=abc", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(422);
  });

  it("rejects a too-large ?limit at the HTTP boundary", async () => {
    const alice = await registerAndGetToken("a@e.com", "alice");
    const res = await recsApp.handle(
      new Request("http://localhost/recommendations/connections?limit=1000", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(422);
  });

  // -------------------------------------------------------------------------
  // Rate limiting (S-H1/P-C2)
  // -------------------------------------------------------------------------

  it("returns 429 when the rate limiter rejects", async () => {
    const alice = await registerAndGetToken("a@e.com", "alice");
    // Build an app with a limiter that always fails closed.
    const { createRecommendationRoutes: mkRoutes } =
      await import("../../src/routes/recommendations");
    const alwaysRejected = { check: () => Promise.resolve(false) };
    const limitedApp = mkRoutes(config, layer, undefined, alwaysRejected);
    const res = await limitedApp.handle(
      new Request("http://localhost/recommendations/connections", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(429);
  });
});
