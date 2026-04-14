import { it, expect } from "@effect/vitest";
import { Effect } from "effect";

import {
  getCloseFriendIds,
  getCloseFriendsOf,
  getConnectionIds,
  getProfileDisplays,
  type OsnDb,
} from "../../src/services/graphBridge";
import {
  createOsnTestContext,
  seedCloseFriend,
  seedConnection,
  seedOsnUser,
} from "../helpers/osnDb";

// graphBridge is the single seam between Pulse and OSN identity. When the
// S2S strategy migrates from direct package import to ARC-token HTTP (per
// CLAUDE.md), this file is the planned mutation point — pinning behaviour
// here means the rewrite can be validated against the same test surface
// without touching rsvps.ts.

// Tests share the same osn instance between Effect.provide and the seed
// helpers so writes via the drizzle client land in the same in-memory
// SQLite that the layer reads from.
const withOsn = <A, E>(
  body: (osn: ReturnType<typeof createOsnTestContext>) => Effect.Effect<A, E, OsnDb>,
): Effect.Effect<A, E, never> =>
  Effect.suspend(() => {
    const osn = createOsnTestContext();
    return body(osn).pipe(Effect.provide(osn.layer));
  });

// ── getConnectionIds ─────────────────────────────────────────────────────────

it.effect("getConnectionIds returns an empty Set when the user has no connections", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_alice" }));
      const ids = yield* getConnectionIds("usr_alice");
      expect(ids).toBeInstanceOf(Set);
      expect(ids.size).toBe(0);
    }),
  ),
);

it.effect("getConnectionIds returns the requester's accepted connections", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_alice" }));
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_bob" }));
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_carol" }));
      yield* Effect.promise(() => seedConnection(osn, "usr_alice", "usr_bob"));
      yield* Effect.promise(() => seedConnection(osn, "usr_alice", "usr_carol"));
      const ids = yield* getConnectionIds("usr_alice");
      expect(ids.size).toBe(2);
      expect(ids.has("usr_bob")).toBe(true);
      expect(ids.has("usr_carol")).toBe(true);
    }),
  ),
);

it.effect("getConnectionIds returns connections regardless of who requested", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_alice" }));
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_bob" }));
      // Bob requested Alice — Alice's perspective should still include Bob.
      yield* Effect.promise(() => seedConnection(osn, "usr_bob", "usr_alice"));
      const ids = yield* getConnectionIds("usr_alice");
      expect(ids.has("usr_bob")).toBe(true);
    }),
  ),
);

// ── getCloseFriendIds ────────────────────────────────────────────────────────

it.effect("getCloseFriendIds returns an empty Set when no close friends exist", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_alice" }));
      const ids = yield* getCloseFriendIds("usr_alice");
      expect(ids.size).toBe(0);
    }),
  ),
);

it.effect("getCloseFriendIds returns the user's close-friend ids (directional)", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_alice" }));
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_bob" }));
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_carol" }));
      yield* Effect.promise(() => seedCloseFriend(osn, "usr_alice", "usr_bob"));
      const aliceFriends = yield* getCloseFriendIds("usr_alice");
      const bobFriends = yield* getCloseFriendIds("usr_bob");
      expect(aliceFriends.has("usr_bob")).toBe(true);
      expect(bobFriends.size).toBe(0);
    }),
  ),
);

// ── getProfileDisplays ──────────────────────────────────────────────────────────

it.effect("getProfileDisplays short-circuits on empty input", () =>
  withOsn((_osn) =>
    Effect.gen(function* () {
      const map = yield* getProfileDisplays([]);
      expect(map).toBeInstanceOf(Map);
      expect(map.size).toBe(0);
    }),
  ),
);

it.effect("getProfileDisplays returns a Map keyed by user id", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        seedOsnUser(osn, { id: "usr_alice", handle: "alice", displayName: "Alice" }),
      );
      yield* Effect.promise(() =>
        seedOsnUser(osn, { id: "usr_bob", handle: "bob", displayName: "Bob Smith" }),
      );
      const map = yield* getProfileDisplays(["usr_alice", "usr_bob"]);
      expect(map.size).toBe(2);
      expect(map.get("usr_alice")?.displayName).toBe("Alice");
      expect(map.get("usr_bob")?.displayName).toBe("Bob Smith");
      expect(map.get("usr_bob")?.handle).toBe("bob");
    }),
  ),
);

it.effect("getProfileDisplays omits ids that don't exist in the users table", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        seedOsnUser(osn, { id: "usr_alice", handle: "alice", displayName: "Alice" }),
      );
      const map = yield* getProfileDisplays(["usr_alice", "usr_ghost"]);
      // Ghost user is silently dropped — caller decides how to render the gap.
      expect(map.size).toBe(1);
      expect(map.has("usr_alice")).toBe(true);
      expect(map.has("usr_ghost")).toBe(false);
    }),
  ),
);

// ── getCloseFriendsOf ────────────────────────────────────────────────────────
//
// This is the directionally-correct close-friend check used by the RSVP
// visibility filter. The test pins the contract: the function returns the
// subset of attendee IDs whose users have marked the viewer as a close
// friend. NOT the viewer's own close-friends list.

it.effect("getCloseFriendsOf returns empty Set on empty input (short-circuit)", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_alice" }));
      const result = yield* getCloseFriendsOf("usr_alice", []);
      expect(result.size).toBe(0);
    }),
  ),
);

it.effect("getCloseFriendsOf returns the subset of attendees who marked the viewer", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_alice" }));
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_bob" }));
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_carol" }));
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_dan" }));
      // Bob and Carol both add Alice as a close friend.
      yield* Effect.promise(() => seedCloseFriend(osn, "usr_bob", "usr_alice"));
      yield* Effect.promise(() => seedCloseFriend(osn, "usr_carol", "usr_alice"));
      // Dan does NOT.
      const result = yield* getCloseFriendsOf("usr_alice", ["usr_bob", "usr_carol", "usr_dan"]);
      expect(result.size).toBe(2);
      expect(result.has("usr_bob")).toBe(true);
      expect(result.has("usr_carol")).toBe(true);
      expect(result.has("usr_dan")).toBe(false);
    }),
  ),
);

it.effect("getCloseFriendsOf is directional — viewer-side adds don't count", () =>
  withOsn((osn) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_alice" }));
      yield* Effect.promise(() => seedOsnUser(osn, { id: "usr_bob" }));
      // Alice adds Bob as her close friend, but Bob doesn't reciprocate.
      // The function asks: "did Bob add Alice?" — the answer is no.
      yield* Effect.promise(() => seedCloseFriend(osn, "usr_alice", "usr_bob"));
      const result = yield* getCloseFriendsOf("usr_alice", ["usr_bob"]);
      expect(result.has("usr_bob")).toBe(false);
    }),
  ),
);
