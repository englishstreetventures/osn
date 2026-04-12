import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { createTestLayer } from "../helpers/db";
import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";

const config = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  jwtSecret: "test-secret-at-least-32-characters-long",
};

const auth = createAuthService(config);
const graph = createGraphService();

/** Register two users and return their IDs. */
const setupTwoUsers = Effect.gen(function* () {
  const alice = yield* auth.registerUser("alice@example.com", "alice", "Alice");
  const bob = yield* auth.registerUser("bob@example.com", "bob", "Bob");
  return { alice, bob };
});

/** Register two users and connect them. */
const setupConnected = Effect.gen(function* () {
  const { alice, bob } = yield* setupTwoUsers;
  yield* graph.sendConnectionRequest(alice.id, bob.id);
  yield* graph.acceptConnection(bob.id, alice.id);
  return { alice, bob };
});

// ---------------------------------------------------------------------------
// Connection requests
// ---------------------------------------------------------------------------

describe("sendConnectionRequest", () => {
  it.effect("creates a pending request", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const status = yield* graph.getConnectionStatus(alice.id, bob.id);
      expect(status).toBe("pending_sent");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("from bob's perspective is pending_received", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const status = yield* graph.getConnectionStatus(bob.id, alice.id);
      expect(status).toBe("pending_received");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when connecting to yourself", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerUser("alice@example.com", "alice");
      const error = yield* Effect.flip(graph.sendConnectionRequest(alice.id, alice.id));
      expect(error._tag).toBe("GraphError");
      expect(error.message).toContain("yourself");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when already pending", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const error = yield* Effect.flip(graph.sendConnectionRequest(alice.id, bob.id));
      expect(error._tag).toBe("GraphError");
      expect(error.message).toContain("already exists");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when blocked by target", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockUser(bob.id, alice.id);
      const error = yield* Effect.flip(graph.sendConnectionRequest(alice.id, bob.id));
      expect(error._tag).toBe("GraphError");
      expect(error.message).toContain("Cannot send");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when requester has blocked target", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockUser(alice.id, bob.id);
      const error = yield* Effect.flip(graph.sendConnectionRequest(alice.id, bob.id));
      expect(error._tag).toBe("GraphError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("acceptConnection", () => {
  it.effect("changes status to connected", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      yield* graph.acceptConnection(bob.id, alice.id);
      const status = yield* graph.getConnectionStatus(alice.id, bob.id);
      expect(status).toBe("connected");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if no pending request exists", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const error = yield* Effect.flip(graph.acceptConnection(bob.id, alice.id));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("rejectConnection", () => {
  it.effect("removes the request (status back to none)", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      yield* graph.rejectConnection(bob.id, alice.id);
      const status = yield* graph.getConnectionStatus(alice.id, bob.id);
      expect(status).toBe("none");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if no pending request exists", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const error = yield* Effect.flip(graph.rejectConnection(bob.id, alice.id));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("removeConnection", () => {
  it.effect("removes an accepted connection", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.removeConnection(alice.id, bob.id);
      const status = yield* graph.getConnectionStatus(alice.id, bob.id);
      expect(status).toBe("none");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("can be called by either party", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.removeConnection(bob.id, alice.id);
      const status = yield* graph.getConnectionStatus(alice.id, bob.id);
      expect(status).toBe("none");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if no connection exists", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const error = yield* Effect.flip(graph.removeConnection(alice.id, bob.id));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("listConnections", () => {
  it.effect("returns all connected peers", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      const carol = yield* auth.registerUser("carol@example.com", "carol");
      yield* graph.sendConnectionRequest(alice.id, carol.id);
      yield* graph.acceptConnection(carol.id, alice.id);

      const list = yield* graph.listConnections(alice.id);
      const handles = list.map((c) => c.user.handle).sort();
      expect(handles).toEqual(["bob", "carol"]);
      void bob;
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns empty when no connections", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerUser("alice@example.com", "alice");
      const list = yield* graph.listConnections(alice.id);
      expect(list).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("listPendingRequests", () => {
  it.effect("returns incoming pending requests", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const list = yield* graph.listPendingRequests(bob.id);
      expect(list).toHaveLength(1);
      expect(list[0].user.handle).toBe("alice");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not include outgoing requests", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const list = yield* graph.listPendingRequests(alice.id);
      expect(list).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Close friends
// ---------------------------------------------------------------------------

describe("addCloseFriend", () => {
  it.effect("adds a connected user as close friend", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.addCloseFriend(alice.id, bob.id);
      const list = yield* graph.listCloseFriends(alice.id);
      expect(list).toHaveLength(1);
      expect(list[0].handle).toBe("bob");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if not connected", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const error = yield* Effect.flip(graph.addCloseFriend(alice.id, bob.id));
      expect(error._tag).toBe("GraphError");
      expect(error.message).toContain("Must be connected");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when adding yourself", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerUser("alice@example.com", "alice");
      const error = yield* Effect.flip(graph.addCloseFriend(alice.id, alice.id));
      expect(error._tag).toBe("GraphError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("is unidirectional — bob does not see alice as close friend", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.addCloseFriend(alice.id, bob.id);
      const bobList = yield* graph.listCloseFriends(bob.id);
      expect(bobList).toHaveLength(0);
      void alice;
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("removeCloseFriend", () => {
  it.effect("removes from close friends list", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.addCloseFriend(alice.id, bob.id);
      yield* graph.removeCloseFriend(alice.id, bob.id);
      const list = yield* graph.listCloseFriends(alice.id);
      expect(list).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if not in close friends", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      const error = yield* Effect.flip(graph.removeCloseFriend(alice.id, bob.id));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("isCloseFriendOf", () => {
  it.effect("returns true when marked as close friend", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.addCloseFriend(alice.id, bob.id);
      const result = yield* graph.isCloseFriendOf(alice.id, bob.id);
      expect(result).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns false when not a close friend", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      const result = yield* graph.isCloseFriendOf(alice.id, bob.id);
      expect(result).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("is directional — reverse is false", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.addCloseFriend(alice.id, bob.id);
      const result = yield* graph.isCloseFriendOf(bob.id, alice.id);
      expect(result).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("getCloseFriendsOfBatch", () => {
  it.effect("returns users who marked viewer as close friend", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      // Bob marks Alice as close friend
      yield* graph.addCloseFriend(bob.id, alice.id);
      const result = yield* graph.getCloseFriendsOfBatch(alice.id, [bob.id]);
      expect(result.has(bob.id)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns empty set when no one marked viewer", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      const result = yield* graph.getCloseFriendsOfBatch(alice.id, [bob.id]);
      expect(result.size).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns empty set for empty input", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerUser("alice@example.com", "alice");
      const result = yield* graph.getCloseFriendsOfBatch(alice.id, []);
      expect(result.size).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns multiple matches when several users marked viewer", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      const carol = yield* auth.registerUser("carol@example.com", "carol");
      yield* graph.sendConnectionRequest(alice.id, carol.id);
      yield* graph.acceptConnection(carol.id, alice.id);

      // Both Bob and Carol mark Alice as close friend
      yield* graph.addCloseFriend(bob.id, alice.id);
      yield* graph.addCloseFriend(carol.id, alice.id);

      const result = yield* graph.getCloseFriendsOfBatch(alice.id, [bob.id, carol.id]);
      expect(result.size).toBe(2);
      expect(result.has(bob.id)).toBe(true);
      expect(result.has(carol.id)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("removeConnection cleans up close friends", () => {
  it.effect("removes close friend entries in both directions", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.addCloseFriend(alice.id, bob.id);
      yield* graph.addCloseFriend(bob.id, alice.id);

      yield* graph.removeConnection(alice.id, bob.id);

      const aliceList = yield* graph.listCloseFriends(alice.id);
      const bobList = yield* graph.listCloseFriends(bob.id);
      expect(aliceList).toHaveLength(0);
      expect(bobList).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

describe("blockUser", () => {
  it.effect("adds a block", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockUser(alice.id, bob.id);
      const list = yield* graph.listBlocks(alice.id);
      expect(list).toHaveLength(1);
      expect(list[0].handle).toBe("bob");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("removes existing connection when blocking", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.blockUser(alice.id, bob.id);
      const status = yield* graph.getConnectionStatus(alice.id, bob.id);
      expect(status).toBe("none");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("removes close friend entries when blocking (blocker's list)", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.addCloseFriend(alice.id, bob.id);
      yield* graph.blockUser(alice.id, bob.id);
      const list = yield* graph.listCloseFriends(alice.id);
      expect(list).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("removes close friend entries when blocking (blockee's list)", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      // Bob has alice as a close friend
      yield* graph.addCloseFriend(bob.id, alice.id);
      // Alice blocks bob — should clear bob's list too
      yield* graph.blockUser(alice.id, bob.id);
      const list = yield* graph.listCloseFriends(bob.id);
      expect(list).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("eitherBlocked is true when either party blocks", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockUser(bob.id, alice.id); // bob blocks alice
      const either = yield* graph.eitherBlocked(alice.id, bob.id);
      expect(either).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when blocking yourself", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerUser("alice@example.com", "alice");
      const error = yield* Effect.flip(graph.blockUser(alice.id, alice.id));
      expect(error._tag).toBe("GraphError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("isBlocked returns true after blocking", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockUser(alice.id, bob.id);
      const blocked = yield* graph.isBlocked(alice.id, bob.id);
      expect(blocked).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("unblockUser", () => {
  it.effect("removes the block", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockUser(alice.id, bob.id);
      yield* graph.unblockUser(alice.id, bob.id);
      const blocked = yield* graph.isBlocked(alice.id, bob.id);
      expect(blocked).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if not blocked", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const error = yield* Effect.flip(graph.unblockUser(alice.id, bob.id));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
