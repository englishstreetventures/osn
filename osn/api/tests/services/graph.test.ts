import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;
const graph = createGraphService();

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

/** Register two users and return their IDs. */
const setupTwoUsers = Effect.gen(function* () {
  const alice = yield* auth.registerProfile("alice@example.com", "alice", "Alice");
  const bob = yield* auth.registerProfile("bob@example.com", "bob", "Bob");
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
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
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
      yield* graph.blockProfile(bob.id, alice.id);
      const error = yield* Effect.flip(graph.sendConnectionRequest(alice.id, bob.id));
      expect(error._tag).toBe("GraphError");
      expect(error.message).toContain("Cannot send");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when requester has blocked target", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockProfile(alice.id, bob.id);
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
      const carol = yield* auth.registerProfile("carol@example.com", "carol");
      yield* graph.sendConnectionRequest(alice.id, carol.id);
      yield* graph.acceptConnection(carol.id, alice.id);

      const list = yield* graph.listConnections(alice.id);
      const handles = list.map((c) => c.profile.handle).toSorted();
      expect(handles).toEqual(["bob", "carol"]);
      void bob;
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns empty when no connections", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
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
      expect(list[0].profile.handle).toBe("alice");
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
// Blocks
// ---------------------------------------------------------------------------

describe("blockProfile", () => {
  it.effect("adds a block", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockProfile(alice.id, bob.id);
      const list = yield* graph.listBlocks(alice.id);
      expect(list).toHaveLength(1);
      expect(list[0].handle).toBe("bob");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("removes existing connection when blocking", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupConnected;
      yield* graph.blockProfile(alice.id, bob.id);
      const status = yield* graph.getConnectionStatus(alice.id, bob.id);
      expect(status).toBe("none");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("eitherBlocked is true when either party blocks", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockProfile(bob.id, alice.id); // bob blocks alice
      const either = yield* graph.eitherBlocked(alice.id, bob.id);
      expect(either).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when blocking yourself", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice@example.com", "alice");
      const error = yield* Effect.flip(graph.blockProfile(alice.id, alice.id));
      expect(error._tag).toBe("GraphError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("isBlocked returns true after blocking", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockProfile(alice.id, bob.id);
      const blocked = yield* graph.isBlocked(alice.id, bob.id);
      expect(blocked).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("unblockProfile", () => {
  it.effect("removes the block", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockProfile(alice.id, bob.id);
      yield* graph.unblockProfile(alice.id, bob.id);
      const blocked = yield* graph.isBlocked(alice.id, bob.id);
      expect(blocked).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if not blocked", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const error = yield* Effect.flip(graph.unblockProfile(alice.id, bob.id));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
