/**
 * How many parameters the queries that filter by an id list bind.
 *
 * D1 refuses a statement with more than 100 bound parameters
 * (developers.cloudflare.com/d1/platform/limits/). bun:sqlite, which this suite
 * runs on, allows 999, so a list bound one parameter per element passes here
 * and fails only in production. These tests read the statements drizzle sends
 * through its `logger` hook and assert the count does not grow with the list.
 * The real-D1 proof for the search probes is in `tests/d1/d1-integration.test.ts`.
 */

import { it, expect, describe } from "@effect/vitest";
import { accounts, deletionJobs, organisations, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { lookupProfileEmails } from "../../src/services/account-emails";
import * as accountErasure from "../../src/services/account-erasure";
import { exportLines } from "../../src/services/account-export";
import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";
import { createRecommendationService } from "../../src/services/recommendations";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { type CapturedStatement, createCapturingTestLayer } from "../helpers/db";

let auth: ReturnType<typeof createAuthService>;
const graph = createGraphService();
const recs = createRecommendationService();

beforeAll(async () => {
  auth = createAuthService(await makeTestAuthConfig());
});

/** Parameter counts of the captured statements whose SQL contains `needle`. */
const paramCounts = (captured: CapturedStatement[], needle: string): number[] =>
  captured.filter((c) => c.sql.includes(needle)).map((c) => c.params.length);

/** An account holding `count` profiles, inserted directly. */
const seedAccountWithProfiles = (count: number) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const accountId = `acc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date();
    yield* Effect.promise(() =>
      db.insert(accounts).values({
        id: accountId,
        email: `${accountId}@example.com`,
        passkeyUserId: crypto.randomUUID(),
        maxProfiles: count,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const profileIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `usr_${accountId.slice(4)}_${i}`;
      profileIds.push(id);
      yield* Effect.promise(() =>
        db.insert(users).values({
          id,
          accountId,
          handle: `${accountId.slice(4, 10)}p${i}`,
          displayName: null,
          avatarUrl: null,
          isDefault: i === 0,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    return { accountId, profileIds };
  });

describe("searchProfiles", () => {
  it.effect("binds the candidate ids once per probe, past 60 candidates", () => {
    const { layer, captured } = createCapturingTestLayer();
    return Effect.gen(function* () {
      // At limit 20 the handle-prefix pass alone returns 60 candidates. The
      // block and connection probes name the list twice, so one parameter per
      // id would be 122 — over D1's 100.
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      for (let i = 0; i < 61; i++) {
        yield* auth.registerProfile(`p${i}@example.com`, `pat${String(i).padStart(2, "0")}`);
      }
      captured.length = 0;

      const result = yield* recs.searchProfiles(alice.id, "pat", 20);

      expect(result).toHaveLength(20);
      // Two profile-id binds and the list twice, as two JSON parameters.
      expect(paramCounts(captured, '"blocks"."blocked_id" in (')).toEqual([4]);
      expect(paramCounts(captured, '"connections"."addressee_id" in (')).toEqual([4]);
      // The caller's id and the list.
      expect(paramCounts(captured, '"organisation_members"."profile_id" in (')).toEqual([2]);
    }).pipe(Effect.provide(layer));
  });
});

describe("searchOrganisations", () => {
  it.effect("binds the candidate organisation ids once, past 60 candidates", () => {
    const { layer, captured } = createCapturingTestLayer();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const { db } = yield* Db;
      const now = new Date();
      for (let i = 0; i < 61; i++) {
        yield* Effect.promise(() =>
          db.insert(organisations).values({
            id: `org_bulk_${i}`,
            handle: `acme${String(i).padStart(2, "0")}`,
            name: `Acme ${i}`,
            ownerId: alice.id,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      captured.length = 0;

      const result = yield* recs.searchOrganisations(alice.id, "acme", 20);

      expect(result).toHaveLength(20);
      expect(paramCounts(captured, '"organisation_members"."organisation_id" in (')).toEqual([2]);
    }).pipe(Effect.provide(layer));
  });
});

describe("graph list reads", () => {
  it.effect("hydrate each list's profiles with one bound parameter", () => {
    const { layer, captured } = createCapturingTestLayer();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const peers = [];
      for (let i = 0; i < 12; i++) {
        peers.push(yield* auth.registerProfile(`peer${i}@example.com`, `peer${i}`));
      }
      // Three connections, three requests in, three out, three blocked.
      for (const peer of peers.slice(0, 3)) {
        yield* graph.sendConnectionRequest(alice.id, peer.id);
        yield* graph.acceptConnection(peer.id, alice.id);
      }
      for (const peer of peers.slice(3, 6)) yield* graph.sendConnectionRequest(peer.id, alice.id);
      for (const peer of peers.slice(6, 9)) yield* graph.sendConnectionRequest(alice.id, peer.id);

      const reads: [string, () => Effect.Effect<readonly unknown[], unknown, Db>][] = [
        ["listConnections", () => graph.listConnections(alice.id)],
        ["listPendingRequests", () => graph.listPendingRequests(alice.id)],
        ["listOutgoingRequests", () => graph.listOutgoingRequests(alice.id)],
        ["listBlocks", () => graph.listBlocks(alice.id)],
      ];
      for (const peer of peers.slice(9, 12)) yield* graph.blockProfile(alice.id, peer.id);
      const seen: Record<string, { rows: number; params: number[] }> = {};
      for (const [name, read] of reads) {
        captured.length = 0;
        const rows = yield* read();
        seen[name] = { rows: rows.length, params: paramCounts(captured, '"users"."id" in (') };
      }

      expect(seen).toEqual({
        listConnections: { rows: 3, params: [1] },
        listPendingRequests: { rows: 3, params: [1] },
        listOutgoingRequests: { rows: 3, params: [1] },
        listBlocks: { rows: 3, params: [1] },
      });
    }).pipe(Effect.provide(layer));
  });
});

describe("lookupProfileEmails", () => {
  it.effect("binds the id list as one parameter at the 100-id cap", () => {
    const { layer, captured } = createCapturingTestLayer();
    return Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const ids = [alice.id, ...Array.from({ length: 99 }, (_, i) => `usr_absent_${i}`)];
      captured.length = 0;

      const found = yield* lookupProfileEmails(ids);

      expect(found.map((f) => f.profileId)).toEqual([alice.id]);
      expect(paramCounts(captured, '"users"."id" in (')).toEqual([1]);
    }).pipe(Effect.provide(layer));
  });
});

describe("account erasure and export", () => {
  it.effect("the hard-delete sweep binds an account's profile ids once per list", () => {
    const { layer, captured } = createCapturingTestLayer();
    return Effect.gen(function* () {
      const { accountId } = yield* seedAccountWithProfiles(3);
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000,
          pulseDoneAt: 1_500,
          zapDoneAt: 1_500,
          reason: "user_request",
          cancelSessionId: null,
        }),
      );
      captured.length = 0;

      const result = yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 });

      expect(result.purged).toBe(1);
      // The list twice, as two JSON parameters.
      expect(paramCounts(captured, 'delete from "connections"')).toEqual([2]);
      expect(paramCounts(captured, 'delete from "blocks"')).toEqual([2]);
      expect(paramCounts(captured, 'delete from "organisation_members"')).toEqual([1]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the export binds an account's profile ids once per list", () => {
    const { layer, captured, db } = createCapturingTestLayer();
    return Effect.gen(function* () {
      const { accountId } = yield* seedAccountWithProfiles(3);
      captured.length = 0;

      const lines = yield* Effect.promise(async () => {
        const out: string[] = [];
        for await (const line of exportLines({
          db,
          accountId,
          downstreams: [],
          fetchStream: async () => new Response(""),
        })) {
          out.push(line);
        }
        return out;
      });

      expect(lines.filter((l) => l.includes('"section":"profiles"'))).toHaveLength(3);
      // Each keyset page binds the list (twice for connections), the cursor
      // and the page size.
      expect(paramCounts(captured, 'from "connections"')).toEqual([4]);
      expect(paramCounts(captured, 'from "blocks"')).toEqual([3]);
      expect(paramCounts(captured, '"organisations"."owner_id" in (')).toEqual([3]);
      expect(paramCounts(captured, '"organisation_members"."profile_id" in (')).toEqual([3]);
    }).pipe(Effect.provide(layer));
  });
});
