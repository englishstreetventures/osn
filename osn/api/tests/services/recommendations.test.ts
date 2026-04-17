import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";

import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";
import { createRecommendationService } from "../../src/services/recommendations";
import { createTestLayer } from "../helpers/db";

const config = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  jwtSecret: "test-secret-at-least-32-characters-long",
};

const auth = createAuthService(config);
const graph = createGraphService();
const recs = createRecommendationService();

// Connect two users bidirectionally (request + accept).
const connect = (a: string, b: string) =>
  Effect.gen(function* () {
    yield* graph.sendConnectionRequest(a, b);
    yield* graph.acceptConnection(b, a);
  });

describe("suggestConnections", () => {
  it.effect("returns [] when caller has no connections", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const result = yield* recs.suggestConnections(alice.id);
      expect(result).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("surfaces friends-of-friends with correct mutual count", () =>
    Effect.gen(function* () {
      // alice <-> bob, alice <-> charlie; bob <-> dana; charlie <-> dana
      // alice should be suggested dana with mutualCount = 2
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const charlie = yield* auth.registerProfile("c@e.com", "charlie");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      yield* connect(alice.id, bob.id);
      yield* connect(alice.id, charlie.id);
      yield* connect(bob.id, dana.id);
      yield* connect(charlie.id, dana.id);

      const result = yield* recs.suggestConnections(alice.id);
      expect(result).toHaveLength(1);
      expect(result[0]!.handle).toBe("dana");
      expect(result[0]!.mutualCount).toBe(2);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("excludes existing connections of the caller", () =>
    Effect.gen(function* () {
      // alice <-> bob, alice <-> dana, bob <-> dana
      // dana is already connected to alice — should NOT appear as suggestion
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      yield* connect(alice.id, bob.id);
      yield* connect(alice.id, dana.id);
      yield* connect(bob.id, dana.id);

      const result = yield* recs.suggestConnections(alice.id);
      expect(result).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("excludes the caller from their own suggestions", () =>
    Effect.gen(function* () {
      // alice <-> bob, bob <-> alice — ensure caller never suggests self
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      yield* connect(alice.id, bob.id);

      const result = yield* recs.suggestConnections(alice.id);
      expect(result.map((s) => s.handle)).not.toContain("alice");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("excludes blocked profiles (either direction)", () =>
    Effect.gen(function* () {
      // alice <-> bob; bob <-> dana; alice blocks dana -> dana should not appear
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      yield* connect(alice.id, bob.id);
      yield* connect(bob.id, dana.id);
      yield* graph.blockProfile(alice.id, dana.id);

      const result = yield* recs.suggestConnections(alice.id);
      expect(result.map((s) => s.handle)).not.toContain("dana");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("sorts suggestions by mutual count descending", () =>
    Effect.gen(function* () {
      // alice <-> bob, alice <-> charlie
      // bob <-> dana (dana has 1 mutual via bob)
      // bob <-> eli, charlie <-> eli (eli has 2 mutuals)
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const charlie = yield* auth.registerProfile("c@e.com", "charlie");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      const eli = yield* auth.registerProfile("e@e.com", "eli");
      yield* connect(alice.id, bob.id);
      yield* connect(alice.id, charlie.id);
      yield* connect(bob.id, dana.id);
      yield* connect(bob.id, eli.id);
      yield* connect(charlie.id, eli.id);

      const result = yield* recs.suggestConnections(alice.id);
      expect(result).toHaveLength(2);
      expect(result[0]!.handle).toBe("eli");
      expect(result[0]!.mutualCount).toBe(2);
      expect(result[1]!.handle).toBe("dana");
      expect(result[1]!.mutualCount).toBe(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("clamps limit to a maximum of 50", () =>
    Effect.gen(function* () {
      // Register alice + 1 friend + 60 friends-of-friend. Verify even when
      // caller asks for 1000, result length is at most 50.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      yield* connect(alice.id, bob.id);

      for (let i = 0; i < 60; i++) {
        const fof = yield* auth.registerProfile(`u${i}@e.com`, `u${i}`);
        yield* connect(bob.id, fof.id);
      }

      const result = yield* recs.suggestConnections(alice.id, 1000);
      expect(result.length).toBe(50);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("clamps limit to a minimum of 1 when passed 0 or negative", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      yield* connect(alice.id, bob.id);
      yield* connect(bob.id, dana.id);

      const zero = yield* recs.suggestConnections(alice.id, 0);
      const neg = yield* recs.suggestConnections(alice.id, -5);
      expect(zero.length).toBe(1);
      expect(neg.length).toBe(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "does not surface friend-of-friend edges that are between two of the caller's own friends",
    () =>
      Effect.gen(function* () {
        // alice <-> bob, alice <-> charlie, bob <-> charlie
        // The bob<->charlie edge is between two of alice's friends — it should
        // NOT generate a spurious self-suggestion or inflate any count.
        const alice = yield* auth.registerProfile("a@e.com", "alice");
        const bob = yield* auth.registerProfile("b@e.com", "bob");
        const charlie = yield* auth.registerProfile("c@e.com", "charlie");
        yield* connect(alice.id, bob.id);
        yield* connect(alice.id, charlie.id);
        yield* connect(bob.id, charlie.id);

        const result = yield* recs.suggestConnections(alice.id);
        expect(result).toEqual([]);
      }).pipe(Effect.provide(createTestLayer())),
  );
});
