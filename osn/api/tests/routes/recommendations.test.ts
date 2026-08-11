import type { Db } from "@osn/db/service";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createGraphRoutes } from "../../src/routes/graph";
import { createRecommendationRoutes } from "../../src/routes/recommendations";
import { createAuthService } from "../../src/services/auth";
import { createOrganisationService } from "../../src/services/organisation";
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
    displayName?: string,
  ): Promise<{ profileId: string; token: string }> {
    const user = await runWithLayer(auth.registerProfile(email, handle, displayName));
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
      suggestions: Array<Record<string, unknown>>;
    };
    expect(json.suggestions).toHaveLength(1);
    // The whole card, key for key. Elysia cleans the body against the route's
    // `response` schema, so a field the schema forgot would vanish here and
    // nowhere else — assert the shape, not just the two fields the UI reads
    // first.
    expect(Object.keys(json.suggestions[0]!).toSorted()).toEqual([
      "avatarUrl",
      "displayName",
      "handle",
      "mutualCount",
      "reason",
      "sharedOrganisation",
    ]);
    expect(json.suggestions[0]!.handle).toBe("dana");
    expect(json.suggestions[0]!.mutualCount).toBe(1);
    expect(json.suggestions[0]!.reason).toBe("mutual_connections");
    expect(json.suggestions[0]!.sharedOrganisation).toBeNull();
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
    const limitedApp = mkRoutes(config, layer, undefined, {
      suggest: alwaysRejected,
      search: alwaysRejected,
    });
    const res = await limitedApp.handle(
      new Request("http://localhost/recommendations/connections", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(429);
  });

  it("guards each route with its own limiter, not the other's budget", async () => {
    // Asymmetric on purpose: denying only `suggest` must 429 /connections and
    // leave /search working. Without this, cross-wiring /connections to the
    // looser 60/min search budget would pass every other rate-limit test.
    const alice = await registerAndGetToken("a@e.com", "alice");
    const suggestOnlyDenied = createRecommendationRoutes(config, layer, undefined, {
      suggest: { check: () => Promise.resolve(false) },
      search: { check: () => Promise.resolve(true) },
    });

    const suggest = await suggestOnlyDenied.handle(
      new Request("http://localhost/recommendations/connections", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    const search = await suggestOnlyDenied.handle(
      new Request("http://localhost/recommendations/search?q=ali", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );

    expect(suggest.status).toBe(429);
    expect(search.status).toBe(200);
  });

  it("fails closed when a limiter backend throws", async () => {
    // The Upstash-unreachable path. Every other limiter stub resolves `false`;
    // only this one reaches the `catch { allowed = false }` branch.
    const alice = await registerAndGetToken("a@e.com", "alice");
    const throwing = { check: () => Promise.reject(new Error("redis unreachable")) };
    const app = createRecommendationRoutes(config, layer, undefined, {
      suggest: throwing,
      search: throwing,
    });

    for (const path of ["/recommendations/connections", "/recommendations/search?q=ali"]) {
      const res = await app.handle(
        new Request(`http://localhost${path}`, {
          headers: { Authorization: `Bearer ${alice.token}` },
        }),
      );
      expect(res.status).toBe(429);
    }
  });

  it("rejects a limiter argument that is missing either slot", () => {
    // The rename from a single backend to the pair invites a caller passing the
    // old shape; this guard is what turns that into a boot-time error rather
    // than a per-request crash on `rateLimiters.suggest.check`.
    const bare = { check: () => Promise.resolve(true) };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately the pre-branch shape
      createRecommendationRoutes(config, layer, undefined, bare as any),
    ).toThrow(/suggest must have a check\(\) method/);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately missing a slot
      createRecommendationRoutes(config, layer, undefined, { suggest: bare } as any),
    ).toThrow(/search must have a check\(\) method/);
  });

  // -------------------------------------------------------------------------
  // Search (autocomplete)
  // -------------------------------------------------------------------------

  describe("GET /recommendations/search", () => {
    async function search(token: string, qs: string) {
      const res = await recsApp.handle(
        new Request(`http://localhost/recommendations/search?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return {
        status: res.status,
        json: (await res.json()) as {
          people?: Array<{ handle: string; connectionStatus: string }>;
          organisations?: Array<{ handle: string; name: string; isMember: boolean }>;
        },
      };
    }

    it("returns 401 without a token", async () => {
      const res = await recsApp.handle(
        new Request("http://localhost/recommendations/search?q=ali"),
      );
      expect(res.status).toBe(401);
    });

    it("rejects a missing q at the HTTP boundary", async () => {
      const alice = await registerAndGetToken("a@e.com", "alice");
      const { status } = await search(alice.token, "");
      expect(status).toBe(422);
    });

    it("matches by handle prefix and reports connection status", async () => {
      const alice = await registerAndGetToken("a@e.com", "alice");
      await registerAndGetToken("b@e.com", "alicia");
      await registerAndGetToken("c@e.com", "bob");

      const { status, json } = await search(alice.token, "q=ali");
      expect(status).toBe(200);
      // Alice herself is excluded; `alicia` is the only other `ali*` handle.
      expect(json.people?.map((r) => r.handle)).toEqual(["alicia"]);
      expect(json.people?.[0]!.connectionStatus).toBe("none");
    });

    it("reflects an in-flight request as pending_sent", async () => {
      const alice = await registerAndGetToken("a@e.com", "alice");
      await registerAndGetToken("b@e.com", "bob");
      await graphApp.handle(
        new Request("http://localhost/graph/connections/bob", {
          method: "POST",
          headers: { Authorization: `Bearer ${alice.token}` },
        }),
      );

      const { json } = await search(alice.token, "q=bob");
      expect(json.people?.[0]!.connectionStatus).toBe("pending_sent");
    });

    it("widens result scope with query length rather than gating on it", async () => {
      // One character reaches the caller's own edges only; two reaches the
      // global handle index. Asserting this at the route layer matters because
      // the scope rule and the people/organisation fan-out meet here — and
      // because a caller with no connections makes the one-character case pass
      // vacuously, which is what this test used to do.
      const alice = await registerAndGetToken("a@e.com", "alice");
      const bob = await registerAndGetToken("b@e.com", "bob");
      await registerAndGetToken("c@e.com", "bella");
      await connect(alice.token, "bob", bob.token, "alice");

      const one = await search(alice.token, "q=b");
      expect(one.status).toBe(200);
      expect(one.json.people?.map((p) => p.handle)).toEqual(["bob"]);

      const two = await search(alice.token, "q=be");
      expect(two.json.people?.map((p) => p.handle)).toEqual(["bella"]);
    });

    it("returns 200 with empty lists for a query that normalises to nothing", async () => {
      // Empty, not a 4xx — a half-typed query is not a client error.
      const alice = await registerAndGetToken("a@e.com", "alice");
      await registerAndGetToken("b@e.com", "ab");
      const { status, json } = await search(alice.token, "q=%40");
      expect(status).toBe(200);
      expect(json.people).toEqual([]);
      expect(json.organisations).toEqual([]);
    });

    it("carries a multi-word query through the boundary intact", async () => {
      const alice = await registerAndGetToken("a@e.com", "alice");
      await registerAndGetToken("j@e.com", "jsm", "John Smith");

      const { json } = await search(alice.token, "q=smith+john");
      expect(json.people?.map((p) => p.handle)).toEqual(["jsm"]);
    });

    it("rejects an out-of-range ?limit at the HTTP boundary", async () => {
      const alice = await registerAndGetToken("a@e.com", "alice");
      const { status } = await search(alice.token, "q=ali&limit=100");
      expect(status).toBe(422);
    });

    it("returns matching organisations alongside people", async () => {
      const alice = await registerAndGetToken("a@e.com", "alice");
      await runWithLayer(
        createOrganisationService().createOrganisation(alice.profileId, "acme", "Acme Inc"),
      );

      const { status, json } = await search(alice.token, "q=acme");
      expect(status).toBe(200);
      expect(json.organisations?.map((o) => o.handle)).toEqual(["acme"]);
      // The caller owns it, so they're a member — the row renders a badge.
      expect(json.organisations?.[0]!.isMember).toBe(true);
    });

    it("rejects an out-of-range ?orgLimit at the HTTP boundary", async () => {
      const alice = await registerAndGetToken("a@e.com", "alice");
      const { status } = await search(alice.token, "q=ali&orgLimit=0");
      expect(status).toBe(422);
    });

    it("derives orgLimit as half of limit when the caller omits it", async () => {
      const alice = await registerAndGetToken("a@e.com", "alice");
      const orgService = createOrganisationService();
      for (let i = 0; i < 5; i++) {
        await runWithLayer(orgService.createOrganisation(alice.profileId, `acme${i}`, `Acme ${i}`));
      }

      const { json } = await search(alice.token, "q=acme&limit=3");
      // ceil(3 / 2) = 2 — organisations are the secondary section, so they get
      // a shorter list than people unless the caller asks otherwise.
      expect(json.organisations).toHaveLength(2);
    });

    it("returns 429 when the search limiter rejects", async () => {
      const alice = await registerAndGetToken("a@e.com", "alice");
      const { createRecommendationRoutes: mkRoutes } =
        await import("../../src/routes/recommendations");
      const limitedApp = mkRoutes(config, layer, undefined, {
        suggest: { check: () => Promise.resolve(true) },
        search: { check: () => Promise.resolve(false) },
      });
      const res = await limitedApp.handle(
        new Request("http://localhost/recommendations/search?q=ali", {
          headers: { Authorization: `Bearer ${alice.token}` },
        }),
      );
      expect(res.status).toBe(429);
    });
  });
});
