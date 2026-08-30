import { it, expect, describe } from "@effect/vitest";
import { accounts, organisations } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";
import { createOrganisationService } from "../../src/services/organisation";
import { createRecommendationService } from "../../src/services/recommendations";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;
const graph = createGraphService();
const orgs = createOrganisationService();
const recs = createRecommendationService();

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

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

  it.effect("labels friend-of-friend suggestions with the mutual_connections reason", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      yield* connect(alice.id, bob.id);
      yield* connect(bob.id, dana.id);

      const result = yield* recs.suggestConnections(alice.id);
      expect(result[0]!.reason).toBe("mutual_connections");
      expect(result[0]!.sharedOrganisation).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("excludes profiles with a connection request already in flight", () =>
    Effect.gen(function* () {
      // alice <-> bob, bob <-> dana, and alice has already asked dana.
      // Re-suggesting dana would produce a Connect button that always fails.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      yield* connect(alice.id, bob.id);
      yield* connect(bob.id, dana.id);
      yield* graph.sendConnectionRequest(alice.id, dana.id);

      const result = yield* recs.suggestConnections(alice.id);
      expect(result.map((s) => s.handle)).not.toContain("dana");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("excludes profiles who have sent the caller a request", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      yield* connect(alice.id, bob.id);
      yield* connect(bob.id, dana.id);
      yield* graph.sendConnectionRequest(dana.id, alice.id);

      const result = yield* recs.suggestConnections(alice.id);
      expect(result.map((s) => s.handle)).not.toContain("dana");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // ---------------------------------------------------------------------------
  // Shared-organisation suggestions (the cold-start signal)
  // ---------------------------------------------------------------------------

  it.effect("suggests organisation co-members to a caller with no connections", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const org = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.addMember(org.id, alice.id, bob.id, "member");

      const result = yield* recs.suggestConnections(alice.id);
      expect(result).toHaveLength(1);
      expect(result[0]!.handle).toBe("bob");
      expect(result[0]!.reason).toBe("shared_organisation");
      expect(result[0]!.mutualCount).toBe(0);
      expect(result[0]!.sharedOrganisation).toEqual({ handle: "acme", name: "Acme Inc" });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks mutual connections above shared organisations", () =>
    Effect.gen(function* () {
      // dana is a friend-of-friend; erin only shares an organisation.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      const erin = yield* auth.registerProfile("e@e.com", "erin");
      yield* connect(alice.id, bob.id);
      yield* connect(bob.id, dana.id);
      const org = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.addMember(org.id, alice.id, erin.id, "member");

      const result = yield* recs.suggestConnections(alice.id);
      expect(result.map((s) => s.handle)).toEqual(["dana", "erin"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("annotates a friend-of-friend who is also an organisation co-member", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      yield* connect(alice.id, bob.id);
      yield* connect(bob.id, dana.id);
      const org = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.addMember(org.id, alice.id, dana.id, "member");

      const result = yield* recs.suggestConnections(alice.id);
      expect(result).toHaveLength(1);
      // Mutual connections are the stronger signal, so they name the reason —
      // but the shared organisation still rides along as card context.
      expect(result[0]!.reason).toBe("mutual_connections");
      expect(result[0]!.sharedOrganisation).toEqual({ handle: "acme", name: "Acme Inc" });
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The hydration is a keyed lookup into a map built after ranking, which the
  // old inner join could not get wrong. Two candidates in two different live
  // organisations is the smallest case that tells a keyed lookup from an
  // unkeyed one: with only one organisation in the map, returning "whatever is
  // in there" and returning "the right one" are the same answer, and a card
  // wearing another organisation's name would ship green.
  it.effect("labels each candidate with the organisation it actually shares", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const cara = yield* auth.registerProfile("c@e.com", "cara");
      const acme = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      const beta = yield* orgs.createOrganisation(alice.id, "beta", "Beta Ltd");
      yield* orgs.addMember(acme.id, alice.id, bob.id, "member");
      yield* orgs.addMember(beta.id, alice.id, cara.id, "member");

      const result = yield* recs.suggestConnections(alice.id);
      const byHandle = new Map(result.map((x) => [x.handle, x.sharedOrganisation]));

      expect(byHandle.get("bob")).toEqual({ handle: "acme", name: "Acme Inc" });
      expect(byHandle.get("cara")).toEqual({ handle: "beta", name: "Beta Ltd" });
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The same lookup when the map is only partly populated: one label survives,
  // one candidate loses its organisation but keeps its mutual connection, and
  // a third loses the only basis it had.
  it.effect("hydrates a partial map without borrowing another candidate's label", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const cara = yield* auth.registerProfile("c@e.com", "cara");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      const erin = yield* auth.registerProfile("e@e.com", "erin");

      const acme = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      const beta = yield* orgs.createOrganisation(alice.id, "beta", "Beta Ltd");
      yield* orgs.addMember(acme.id, alice.id, bob.id, "member");
      yield* orgs.addMember(beta.id, alice.id, cara.id, "member");
      yield* orgs.addMember(beta.id, alice.id, erin.id, "member");
      // dana is a friend-of-friend, so she survives losing her label.
      yield* connect(alice.id, cara.id);
      yield* connect(cara.id, dana.id);

      const { db } = yield* Db;
      yield* Effect.promise(() => db.delete(organisations).where(eq(organisations.id, beta.id)));

      const result = yield* recs.suggestConnections(alice.id);
      const byHandle = new Map(result.map((x) => [x.handle, x.sharedOrganisation]));

      // bob keeps the organisation he actually shares — not beta's name, and
      // not a label borrowed from the one entry left in the map.
      expect(byHandle.get("bob")).toEqual({ handle: "acme", name: "Acme Inc" });
      // dana stands on the mutual connection, with no label.
      expect(byHandle.get("dana")).toBeNull();
      // erin's only basis was beta, which is gone.
      expect(byHandle.has("erin")).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("never suggests a friend-of-friend whose account is tombstoned", () =>
    Effect.gen(function* () {
      // Art. 17 erasure is pending on dana's account — she must not resurface
      // in Discover while the deletion sweeper works through the grace window.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      yield* connect(alice.id, bob.id);
      yield* connect(bob.id, dana.id);

      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(accounts)
          .set({ deletedAt: 1_700_000_000 })
          .where(eq(accounts.id, dana.accountId)),
      );

      expect(yield* recs.suggestConnections(alice.id)).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Hydration happens after ranking, so an organisation can disappear between
  // the fan-out reading its membership row and the lookup reading its name.
  // The suggestion has to survive that with no label rather than vanish or
  // carry a stale one.
  //
  // The state is reached by deleting the row directly. It cannot persist —
  // `deleteOrganisation` removes the membership rows and the organisation in
  // one batch, and D1 enforces the foreign key besides (this harness does not;
  // see the pragma finding). What it can be is a read race: the fan-out and
  // the hydration are two statements now rather than one join, so an
  // organisation deleted between them lands exactly here.
  it.effect("drops the label, not the suggestion, when the organisation is gone", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const dana = yield* auth.registerProfile("d@e.com", "dana");
      // dana is a friend-of-friend as well as a co-member, so the suggestion
      // still stands on its mutual connection once the label is gone.
      yield* connect(alice.id, bob.id);
      yield* connect(bob.id, dana.id);
      const org = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.addMember(org.id, alice.id, dana.id, "member");

      const { db } = yield* Db;
      yield* Effect.promise(() => db.delete(organisations).where(eq(organisations.id, org.id)));

      const result = yield* recs.suggestConnections(alice.id);
      expect(result).toHaveLength(1);
      expect(result[0]!.handle).toBe("dana");
      expect(result[0]!.reason).toBe("mutual_connections");
      expect(result[0]!.sharedOrganisation).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The other side of the same branch: with no mutual connection, a shared
  // organisation that no longer exists leaves the candidate with no basis at
  // all. Asserting `shared_organisation` while naming nothing is worse than
  // not suggesting them, and this is exactly what the fan-out's old inner
  // join to `organisations` used to do.
  it.effect("drops an organisation-only candidate whose organisation is gone", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const org = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.addMember(org.id, alice.id, bob.id, "member");

      // bob is suggested while the organisation exists.
      expect((yield* recs.suggestConnections(alice.id)).map((x) => x.handle)).toEqual(["bob"]);

      const { db } = yield* Db;
      yield* Effect.promise(() => db.delete(organisations).where(eq(organisations.id, org.id)));

      expect(yield* recs.suggestConnections(alice.id)).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("never suggests an organisation co-member the caller has blocked", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      const org = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.addMember(org.id, alice.id, bob.id, "member");
      yield* graph.blockProfile(alice.id, bob.id);

      const result = yield* recs.suggestConnections(alice.id);
      expect(result).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// searchProfiles
// ---------------------------------------------------------------------------

describe("searchProfiles", () => {
  it.effect("returns [] for an empty query", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "ab");

      expect(yield* recs.searchProfiles(alice.id, "")).toEqual([]);
      expect(yield* recs.searchProfiles(alice.id, "   ")).toEqual([]);
      expect(yield* recs.searchProfiles(alice.id, "@")).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("answers a one-character query from the caller's connections only", () =>
    Effect.gen(function* () {
      // A single character reaches the caller's own edges — a set they can
      // already enumerate via GET /graph/connections, so no length gate on it
      // buys any enumeration resistance — but never the global index.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      yield* auth.registerProfile("c@e.com", "bella");
      yield* connect(alice.id, bob.id);

      expect((yield* recs.searchProfiles(alice.id, "b")).map((r) => r.handle)).toEqual(["bob"]);
      // Two characters unlocks the global prefix pass, and @bella appears.
      expect((yield* recs.searchProfiles(alice.id, "be")).map((r) => r.handle)).toEqual(["bella"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a one-character query from a caller with no connections returns []", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bob");

      expect(yield* recs.searchProfiles(alice.id, "b")).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a separator cannot buy length past the global gates", () =>
    Effect.gen(function* () {
      // The gates are the enumeration control, so what they FORBID has to be
      // asserted, not just what they allow. Each of these is a query whose
      // string is long enough to pass a naive `phrase.length` check while
      // carrying one character of actual signal — which is why the gates read
      // the tokens instead (`handleQuery` for the prefix seek, longest token
      // for the infix scan).
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bob", "Bobby Tables");

      // "b." / "b!" / "b-" would be a one-character handle seek; "b b" would be
      // a one-character infix scan. None may reach a non-connection.
      for (const q of ["b.", "b!", "b-", "b b", "b_"]) {
        expect(yield* recs.searchProfiles(alice.id, q)).toEqual([]);
      }

      // The honest two- and three-character queries still work — including the
      // separated form, which is not a bypass: "b o" rejoins to the handle
      // prefix "bo", and the caller really did type two characters. That
      // rejoin is the same mechanism that resolves "john smith" to @johnsmith.
      expect((yield* recs.searchProfiles(alice.id, "bo")).map((r) => r.handle)).toEqual(["bob"]);
      expect((yield* recs.searchProfiles(alice.id, "b o")).map((r) => r.handle)).toEqual(["bob"]);
      expect((yield* recs.searchProfiles(alice.id, "obb")).map((r) => r.handle)).toEqual(["bob"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a short token alongside a real one still scans", () =>
    Effect.gen(function* () {
      // The infix gate reads the LONGEST token, not the total and not the
      // shortest: an AND of LIKE patterns is only as selective as its most
      // selective conjunct. "j smith" carries a real term and must run, where
      // "j s" carries none and must not.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("j@e.com", "zzz", "John Smith");

      expect((yield* recs.searchProfiles(alice.id, "j smith")).map((r) => r.handle)).toEqual([
        "zzz",
      ]);
      expect(yield* recs.searchProfiles(alice.id, "j s")).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("treats a typed % literally rather than as a wildcard", () =>
    Effect.gen(function* () {
      // `escapeLike` can only neutralise a metacharacter that survives
      // tokenisation. If `%` were a separator, "a%e" would become `%a%` AND
      // `%e%` and match @alice — the exact widening the escape exists to stop.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bob", "100% Cotton");

      expect(yield* recs.searchProfiles(alice.id, "a%e")).toEqual([]);
      expect((yield* recs.searchProfiles(alice.id, "100%")).map((r) => r.handle)).toEqual(["bob"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks pending edges between connections and organisation co-members", () =>
    Effect.gen(function* () {
      // Covers all four proximity constants and the tie-break in one ordering.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const connected = yield* auth.registerProfile("c@e.com", "zeta_a");
      const pending = yield* auth.registerProfile("p@e.com", "zeta_b");
      const colleague = yield* auth.registerProfile("o@e.com", "zeta_c");
      yield* auth.registerProfile("s@e.com", "zeta_d");

      yield* connect(alice.id, connected.id);
      yield* graph.sendConnectionRequest(pending.id, alice.id);
      const org = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.addMember(org.id, alice.id, colleague.id, "member");

      const result = yield* recs.searchProfiles(alice.id, "zeta");
      expect(result.map((r) => r.handle)).toEqual(["zeta_a", "zeta_b", "zeta_c", "zeta_d"]);
      expect(result[1]!.connectionStatus).toBe("pending_received");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks a name-token prefix above a name that merely contains the tokens", () =>
    Effect.gen(function* () {
      // lexicalScore's all-tokens-contained fallback: a row the multi-token
      // scan retrieved but which matched neither as a phrase nor as a token
      // prefix must still score above zero, and below a real token prefix.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "yyy", "Blacksmith Johnson");
      yield* auth.registerProfile("j@e.com", "zzz", "John Smith");

      expect((yield* recs.searchProfiles(alice.id, "smith john")).map((r) => r.handle)).toEqual([
        "zzz",
        "yyy",
      ]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("matches on a handle prefix and excludes the caller", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "alicia");
      yield* auth.registerProfile("c@e.com", "bob");

      const result = yield* recs.searchProfiles(alice.id, "ali");
      expect(result.map((r) => r.handle)).toEqual(["alicia"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("strips a leading @ sigil and is case-insensitive", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bobby");

      const result = yield* recs.searchProfiles(alice.id, "@BOB");
      expect(result.map((r) => r.handle)).toEqual(["bobby"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("falls back to display-name and infix matches when the prefix pass is thin", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bob", "Roberta Smith");

      const result = yield* recs.searchProfiles(alice.id, "robert");
      expect(result.map((r) => r.handle)).toEqual(["bob"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not run the infix scan for a two-character query", () =>
    Effect.gen(function* () {
      // The unanchored `%q%` pass is a full table scan, so it is reserved for
      // queries of MIN_INFIX_QUERY_LENGTH or more. A 2-char query still gets
      // prefix matching — it just can't reach into the middle of a name.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "zebra", "Bobby Tables");

      // "ob" appears inside both the display name and nothing else; only the
      // infix pass could find it, and it must not run.
      expect(yield* recs.searchProfiles(alice.id, "ob")).toEqual([]);
      // Three characters unlocks it.
      expect((yield* recs.searchProfiles(alice.id, "obb")).map((r) => r.handle)).toEqual(["zebra"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("matches the handle prefix exactly, without LIKE wildcard semantics", () =>
    Effect.gen(function* () {
      // The prefix pass is a BINARY range seek, not `LIKE 'q%'`. Guard the
      // boundary: the range must not spill past its last character.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "ab");
      yield* auth.registerProfile("c@e.com", "abz");
      yield* auth.registerProfile("d@e.com", "ac");

      const result = yield* recs.searchProfiles(alice.id, "ab");
      expect(result.map((r) => r.handle).toSorted()).toEqual(["ab", "abz"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns [] for a query that cannot prefix any handle", () =>
    Effect.gen(function* () {
      // Handles are `^[a-z0-9_]+$`, so a query with other characters skips the
      // range pass entirely rather than seeking for zero rows.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bob", "Zoë Smith");

      // Still reachable through the display-name pass.
      expect((yield* recs.searchProfiles(alice.id, "zoë")).map((r) => r.handle)).toEqual(["bob"]);
      expect(yield* recs.searchProfiles(alice.id, "!!!")).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks every lexical tier in order", () =>
    Effect.gen(function* () {
      // Tier ordering is the whole lexical contract: exact handle, handle
      // prefix, name-*token* prefix, handle infix, then name infix. Nobody here
      // is connected to the caller, so proximity contributes 0 throughout and
      // the order is the lexical order alone.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("e@e.com", "bob"); // 100 — exact handle
      yield* auth.registerProfile("p@e.com", "bobx"); //  60 — handle prefix
      yield* auth.registerProfile("n@e.com", "zed", "Bobby Zed"); // 50 — first name token
      yield* auth.registerProfile("m@e.com", "zeta", "Rob Bobson"); // 50 — later name token
      yield* auth.registerProfile("i@e.com", "carbob"); //  25 — handle infix
      yield* auth.registerProfile("f@e.com", "yak", "Rabobank Ltd"); // 20 — name infix

      const result = yield* recs.searchProfiles(alice.id, "bob");
      expect(result.map((r) => r.handle)).toEqual([
        "bob",
        "bobx",
        // Both name-token matches, tied at 50 and split by handle. "Rob
        // *Bob*son" ranking above "car*bob*" is the point of the tier: a
        // surname starting with what was typed beats a handle that merely
        // contains it. Under the old flat name-infix tier it ranked last.
        "zed",
        "zeta",
        "carbob",
        "yak",
      ]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks a connection above a stranger on the same lexical tier", () =>
    Effect.gen(function* () {
      // Facebook's typeahead ordering: first-degree results first. Both match
      // the handle prefix identically, so proximity is the only thing between
      // them — and @zoe would otherwise lose to @bella on the handle tie-break.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bella");
      const zoe = yield* auth.registerProfile("z@e.com", "bezoe");
      yield* connect(alice.id, zoe.id);

      const result = yield* recs.searchProfiles(alice.id, "be");
      expect(result.map((r) => r.handle)).toEqual(["bezoe", "bella"]);
      expect(result[0].connectionStatus).toBe("connected");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("lets a connection's weaker text match outrank a stranger's handle prefix", () =>
    Effect.gen(function* () {
      // Connected name-token match (50 + 40) beats a stranger's handle prefix
      // (60). Summing the two scores rather than ordering by one then the other
      // is what makes this expressible at all.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("s@e.com", "smithers");
      const friend = yield* auth.registerProfile("f@e.com", "rbt", "Roberta Smith");
      yield* connect(alice.id, friend.id);

      const result = yield* recs.searchProfiles(alice.id, "smith");
      expect(result.map((r) => r.handle)).toEqual(["rbt", "smithers"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("an exact handle still outranks a connection matched less precisely", () =>
    Effect.gen(function* () {
      // The one case where text must win: the caller typed a whole handle, and
      // a handle is an address. 100 beats 60 + 40 on the lexical tie-break.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bob");
      const friend = yield* auth.registerProfile("f@e.com", "bobby");
      yield* connect(alice.id, friend.id);

      expect((yield* recs.searchProfiles(alice.id, "bob")).map((r) => r.handle)).toEqual([
        "bob",
        "bobby",
      ]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks a shared-organisation co-member above an unrelated stranger", () =>
    Effect.gen(function* () {
      // The signal that stands in for friends-of-friends: only ever counted for
      // organisations the caller belongs to, whose member list the caller can
      // already read — so it discloses nothing ordering could leak.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bella");
      const colleague = yield* auth.registerProfile("c@e.com", "bezoe");
      const org = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.addMember(org.id, alice.id, colleague.id, "member");

      expect((yield* recs.searchProfiles(alice.id, "be")).map((r) => r.handle)).toEqual([
        "bezoe",
        "bella",
      ]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("finds a connection the global prefix window would have crowded out", () =>
    Effect.gen(function* () {
      // The recall guarantee. Every global pass is ORDER BY handle LIMIT
      // overfetch, so a common prefix fills the window with whoever sorts
      // alphabetically first. @zzz_pat sorts behind 40 strangers on "pa" and is
      // retrieved only because the caller's own edges are a pass of their own.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      for (let i = 0; i < 40; i++) {
        yield* auth.registerProfile(`p${i}@e.com`, `pat${String(i).padStart(2, "0")}`);
      }
      const friend = yield* auth.registerProfile("f@e.com", "zzz_pat");
      yield* connect(alice.id, friend.id);

      const result = yield* recs.searchProfiles(alice.id, "pat", 5);
      expect(result[0].handle).toBe("zzz_pat");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("matches a multi-word query against display-name tokens in any order", () =>
    Effect.gen(function* () {
      // One `%john smith%` pattern can only match that exact substring in that
      // exact order; AND-ing a pattern per token is what makes the reversed and
      // punctuated forms findable.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("j@e.com", "jsm", "John Smith");

      for (const q of ["john smith", "smith john", "smi joh", "Smith, John"]) {
        expect((yield* recs.searchProfiles(alice.id, q)).map((r) => r.handle)).toEqual(["jsm"]);
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("resolves a multi-word query to the handle it spells", () =>
    Effect.gen(function* () {
      // "john smith" carries a space, which can't prefix a handle at all — so
      // before the tokens were rejoined this skipped the index seek entirely
      // and found @johnsmith only if the infix scan happened to run.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("j@e.com", "johnsmith");

      expect((yield* recs.searchProfiles(alice.id, "john smith")).map((r) => r.handle)).toEqual([
        "johnsmith",
      ]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("still excludes a blocked profile that matches strongly", () =>
    Effect.gen(function* () {
      // Proximity ranking must never resurrect someone the block filter drops.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const org = yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      yield* orgs.addMember(org.id, alice.id, bob.id, "member");
      yield* graph.blockProfile(alice.id, bob.id);

      expect(yield* recs.searchProfiles(alice.id, "bob")).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("still fills the page when blocked profiles are filtered out", () =>
    Effect.gen(function* () {
      // SEARCH_OVERFETCH_FACTOR exists so application-side block filtering
      // can't leave a short page.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const blocked: string[] = [];
      for (let i = 0; i < 12; i++) {
        const p = yield* auth.registerProfile(`z${i}@e.com`, `zeta${i}`);
        if (i < 4) blocked.push(p.id);
      }
      for (const id of blocked) yield* graph.blockProfile(alice.id, id);

      const result = yield* recs.searchProfiles(alice.id, "zeta", 8);
      expect(result).toHaveLength(8);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("never returns a profile whose account is tombstoned", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const doomed = yield* auth.registerProfile("z@e.com", "zeta");

      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(accounts)
          .set({ deletedAt: 1_700_000_000 })
          .where(eq(accounts.id, doomed.accountId)),
      );

      expect(yield* recs.searchProfiles(alice.id, "zeta")).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks an exact handle match first", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "bobby");
      yield* auth.registerProfile("c@e.com", "bobbie");
      yield* auth.registerProfile("d@e.com", "bob");

      const result = yield* recs.searchProfiles(alice.id, "bob");
      expect(result[0]!.handle).toBe("bob");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("reports the caller's connection state per result", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const connected = yield* auth.registerProfile("b@e.com", "zeta_connected");
      const sent = yield* auth.registerProfile("c@e.com", "zeta_sent");
      const received = yield* auth.registerProfile("d@e.com", "zeta_received");
      yield* auth.registerProfile("e@e.com", "zeta_none");

      yield* connect(alice.id, connected.id);
      yield* graph.sendConnectionRequest(alice.id, sent.id);
      yield* graph.sendConnectionRequest(received.id, alice.id);

      const result = yield* recs.searchProfiles(alice.id, "zeta");
      const byHandle = new Map(result.map((r) => [r.handle, r.connectionStatus]));
      expect(byHandle.get("zeta_connected")).toBe("connected");
      expect(byHandle.get("zeta_sent")).toBe("pending_sent");
      expect(byHandle.get("zeta_received")).toBe("pending_received");
      expect(byHandle.get("zeta_none")).toBe("none");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("excludes profiles blocked in either direction", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const blockedByAlice = yield* auth.registerProfile("b@e.com", "zeta_one");
      const blockerOfAlice = yield* auth.registerProfile("c@e.com", "zeta_two");
      yield* auth.registerProfile("d@e.com", "zeta_three");

      yield* graph.blockProfile(alice.id, blockedByAlice.id);
      yield* graph.blockProfile(blockerOfAlice.id, alice.id);

      const result = yield* recs.searchProfiles(alice.id, "zeta");
      expect(result.map((r) => r.handle)).toEqual(["zeta_three"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("treats an underscore in the query literally, not as a LIKE wildcard", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("b@e.com", "jo_smith");
      yield* auth.registerProfile("c@e.com", "joxsmith");

      const result = yield* recs.searchProfiles(alice.id, "jo_s");
      expect(result.map((r) => r.handle)).toEqual(["jo_smith"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("finds a non-ASCII display name", () =>
    Effect.gen(function* () {
      // Retrieval folds case with SQLite LIKE (ASCII only); ranking folds with
      // JS toLowerCase (full Unicode). The query is lowercased in JS before SQL
      // sees it, so a lowercase-stored accent matches from any input casing.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("m@e.com", "mul", "Zoë Müller");

      for (const q of ["müller", "MÜLLER", "Müller", "zoë mül"]) {
        expect((yield* recs.searchProfiles(alice.id, q)).map((r) => r.handle)).toEqual(["mul"]);
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("finds a CJK display name, whose tokens are two characters", () =>
    Effect.gen(function* () {
      // The infix gate's Latin threshold of 3 would make this name
      // unsearchable — every token of it is two characters wide. Two Han
      // characters is a specific query, so dense scripts clear the gate at 2.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* auth.registerProfile("t@e.com", "taro", "日本 太郎");

      for (const q of ["日本 太郎", "太郎", "日本"]) {
        expect((yield* recs.searchProfiles(alice.id, q)).map((r) => r.handle)).toEqual(["taro"]);
      }
      // One character is still one character in any script.
      expect(yield* recs.searchProfiles(alice.id, "本")).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("truncates the connections pass at its cap, alphabetically", () =>
    Effect.gen(function* () {
      // MAX_CONNECTION_MATCH_ROWS bounds the recall guarantee, so the bound is
      // itself a stated contract: past the cap, which connections survive is
      // decided by handle order, not arbitrarily. 60 matching connections on
      // one edge direction exceeds the 50-row cap.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      for (let i = 0; i < 60; i++) {
        const friend = yield* auth.registerProfile(
          `z${i}@e.com`,
          `zeta${String(i).padStart(2, "0")}`,
        );
        yield* connect(alice.id, friend.id);
      }

      // A one-character query reaches nothing but the connections pass, so the
      // page is drawn purely from its (capped, handle-ordered) output.
      const result = yield* recs.searchProfiles(alice.id, "z", 20);
      expect(result).toHaveLength(20);
      expect(result.map((r) => r.handle)).toEqual(
        Array.from({ length: 20 }, (_, i) => `zeta${String(i).padStart(2, "0")}`),
      );
      expect(result.every((r) => r.connectionStatus === "connected")).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("survives the largest candidate set the bounds allow", () =>
    Effect.gen(function* () {
      // Worst case for the probes that follow retrieval: both edge directions
      // at the cap plus both global passes at `limit × SEARCH_OVERFETCH_FACTOR`
      // is ~220 candidate ids, and the block and edge probes each bind that
      // list twice. This is the test that defends the sizing argument the
      // constants are justified by — SQLite's 999-variable ceiling.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      for (let i = 0; i < 60; i++) {
        const friend = yield* auth.registerProfile(
          `f${i}@e.com`,
          `zeta_f${String(i).padStart(2, "0")}`,
        );
        yield* connect(alice.id, friend.id);
      }
      for (let i = 0; i < 80; i++) {
        yield* auth.registerProfile(`s${i}@e.com`, `zeta_s${String(i).padStart(2, "0")}`);
      }

      const result = yield* recs.searchProfiles(alice.id, "zeta", 20);
      expect(result).toHaveLength(20);
      // Connections outrank strangers on an identical lexical tier, so the
      // whole page comes from the connection set.
      expect(result.every((r) => r.connectionStatus === "connected")).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("surfaces a failing probe as DatabaseError, not a partial result", () =>
    Effect.gen(function* () {
      // The three post-retrieval probes run as one `Effect.all`, which changed
      // the failure semantics: a failing probe now interrupts its siblings.
      // Assert the failure lands in the error channel as the tagged error the
      // route's `catch` expects, rather than escaping as a defect or — worse —
      // yielding a page built from probes that never answered, which would drop
      // the block filter.
      // Built inline rather than via `Effect.provide` on the whole generator,
      // because the raw handle is what lets the failure be injected mid-flight.
      const { layer, sqlite } = createTestLayerWithSqlite();
      const alice = yield* auth.registerProfile("a@e.com", "alice").pipe(Effect.provide(layer));
      yield* auth.registerProfile("b@e.com", "bobby").pipe(Effect.provide(layer));

      // Retrieval succeeds, then the block probe hits a table that is gone.
      sqlite.exec("DROP TABLE blocks");

      const error = yield* Effect.flip(
        recs.searchProfiles(alice.id, "bob").pipe(Effect.provide(layer)),
      );
      expect(error._tag).toBe("DatabaseError");
    }),
  );

  it.effect("clamps the limit to [1, 20]", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      for (let i = 0; i < 25; i++) {
        yield* auth.registerProfile(`z${i}@e.com`, `zeta${i}`);
      }

      expect((yield* recs.searchProfiles(alice.id, "zeta", 1000)).length).toBe(20);
      expect((yield* recs.searchProfiles(alice.id, "zeta", 0)).length).toBe(1);
      expect((yield* recs.searchProfiles(alice.id, "zeta", Number.NaN)).length).toBe(8);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// searchOrganisations
// ---------------------------------------------------------------------------

describe("searchOrganisations", () => {
  it.effect("answers a one-character query from the caller's own organisations only", () =>
    Effect.gen(function* () {
      // One character reaches the caller's own memberships — a set they can
      // already list — but never the global index.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.createOrganisation(bob.id, "apex", "Apex Ltd");

      expect((yield* recs.searchOrganisations(alice.id, "a")).map((o) => o.handle)).toEqual([
        "acme",
      ]);
      // Two characters reaches the global index, so bob finds alice's org.
      expect((yield* recs.searchOrganisations(bob.id, "ac")).map((o) => o.handle)).toEqual([
        "acme",
      ]);
      expect(yield* recs.searchOrganisations(alice.id, "")).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a one-character query from a caller with no memberships returns []", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      yield* orgs.createOrganisation(bob.id, "acme", "Acme Inc");

      expect(yield* recs.searchOrganisations(alice.id, "a")).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("matches on handle prefix and flags the caller's membership", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");
      yield* orgs.createOrganisation(bob.id, "acorn", "Acorn Ltd");

      const result = yield* recs.searchOrganisations(alice.id, "ac");
      expect(result.map((o) => o.handle)).toEqual(["acme", "acorn"]);
      // Creating an organisation makes you an admin member of it.
      expect(result.find((o) => o.handle === "acme")!.isMember).toBe(true);
      expect(result.find((o) => o.handle === "acorn")!.isMember).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("falls back to a name match when the handle prefix pass is thin", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* orgs.createOrganisation(alice.id, "zzz", "Brighton Rowing Club");

      const result = yield* recs.searchOrganisations(alice.id, "rowing");
      expect(result.map((o) => o.handle)).toEqual(["zzz"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks an exact handle match first", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* orgs.createOrganisation(alice.id, "acmecorp", "Acme Corp");
      yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");

      const result = yield* recs.searchOrganisations(alice.id, "acme");
      expect(result[0]!.handle).toBe("acme");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("addresses results by handle, not the internal org_* id", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* orgs.createOrganisation(alice.id, "acme", "Acme Inc");

      const result = yield* recs.searchOrganisations(alice.id, "acme");
      // `GET /organisations/:handle` resolves by handle and the public
      // projection omits the id — leaking it here would hand the client a key
      // nothing accepts.
      expect(result[0]!.handle).toBe("acme");
      expect(result[0]).not.toHaveProperty("id");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("treats an underscore in the query literally", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* orgs.createOrganisation(alice.id, "ac_me", "Underscore Org");
      yield* orgs.createOrganisation(alice.id, "acxme", "Other Org");

      const result = yield* recs.searchOrganisations(alice.id, "ac_m");
      expect(result.map((o) => o.handle)).toEqual(["ac_me"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks an organisation the caller belongs to above a stranger's", () =>
    Effect.gen(function* () {
      // Membership was only ever a badge on rows text ranking had already
      // chosen; it is now part of the score, so it can change which rows those
      // are. @acorn would otherwise win the handle tie-break.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      const bob = yield* auth.registerProfile("b@e.com", "bob");
      yield* orgs.createOrganisation(bob.id, "acorn", "Acorn Ltd");
      yield* orgs.createOrganisation(bob.id, "acme", "Acme Inc");
      const mine = yield* orgs.createOrganisation(bob.id, "acrid", "Acrid Ltd");
      yield* orgs.addMember(mine.id, bob.id, alice.id, "member");

      const result = yield* recs.searchOrganisations(alice.id, "ac");
      expect(result[0]!.handle).toBe("acrid");
      expect(result[0]!.isMember).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ranks a name-token prefix above a handle infix", () =>
    Effect.gen(function* () {
      // "Brighton *Row*ing Club" is the better answer for "rowing" than a
      // handle that merely contains the letters.
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* orgs.createOrganisation(alice.id, "zzz", "Brighton Rowing Club");
      yield* orgs.createOrganisation(alice.id, "aaarowingx", "Unrelated");

      const result = yield* recs.searchOrganisations(alice.id, "rowing");
      expect(result.map((o) => o.handle)).toEqual(["zzz", "aaarowingx"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("matches a multi-word query against name tokens in any order", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("a@e.com", "alice");
      yield* orgs.createOrganisation(alice.id, "brc", "Brighton Rowing Club");

      for (const q of ["brighton club", "club brighton", "row club"]) {
        expect((yield* recs.searchOrganisations(alice.id, q)).map((o) => o.handle)).toEqual([
          "brc",
        ]);
      }
    }).pipe(Effect.provide(createTestLayer())),
  );
});
