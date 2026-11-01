import { it, expect, describe } from "@effect/vitest";
import { Db } from "@osn/db/service";
import { Effect, Fiber, Layer, type Result } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";
import { holdQueries } from "../helpers/held-query";

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

describe("listOutgoingRequests", () => {
  it.effect("returns requests the caller sent", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const list = yield* graph.listOutgoingRequests(alice.id);
      expect(list).toHaveLength(1);
      expect(list[0].profile.handle).toBe("bob");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not include incoming requests", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const list = yield* graph.listOutgoingRequests(bob.id);
      expect(list).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not include accepted connections", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      yield* graph.acceptConnection(bob.id, alice.id);
      const list = yield* graph.listOutgoingRequests(alice.id);
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

/**
 * Each write names the row as its request read it, so a row another request
 * accepted, declined, removed or blocked in between is left as that request
 * left it, and this one is refused as it would be had it read afterwards. Each
 * case holds the write until the other request has landed.
 */
describe("a write after a read changes only the row it read", () => {
  /** The graph service on a database whose statements a test can hold. */
  function held() {
    const { db, sqlite, email } = createTestLayerWithSqlite();
    const queries = holdQueries(db);
    return {
      layer: Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer),
      hold: queries.hold,
      connectionRows: () =>
        (sqlite.query("SELECT COUNT(*) AS n FROM connections").get() as { n: number }).n,
    };
  }

  /** The refusal's message, or `"ok"`. */
  const answer = (outcome: Result.Result<void, { readonly message?: string }>) =>
    outcome._tag === "Success" ? "ok" : (outcome.failure.message ?? "no message");

  /** Runs `write` with its statement matching `pattern` held until `between` has run. */
  const across = <E extends { readonly message?: string }>(
    h: ReturnType<typeof held>,
    pattern: RegExp,
    write: Effect.Effect<void, E, Db>,
    between: Effect.Effect<unknown, unknown, Db>,
  ) =>
    Effect.gen(function* () {
      const gate = h.hold(pattern);
      const fiber = yield* Effect.forkChild(Effect.result(write));
      yield* Effect.promise(() => gate.reached);
      yield* between;
      gate.release();
      return answer(yield* Fiber.join(fiber));
    });

  it.live("a decline leaves a request accepted since it read it", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const declined = yield* across(
        h,
        /^delete from "connections"/,
        graph.rejectConnection(bob.id, alice.id),
        graph.acceptConnection(bob.id, alice.id),
      );
      expect(declined).toBe("Pending request not found");
      expect(yield* graph.getConnectionStatus(alice.id, bob.id)).toBe("connected");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("an accept is refused once the request it read is declined", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const accepted = yield* across(
        h,
        /^update "connections"/,
        graph.acceptConnection(bob.id, alice.id),
        graph.rejectConnection(bob.id, alice.id),
      );
      expect(accepted).toBe("Pending request not found");
      expect(yield* graph.getConnectionStatus(alice.id, bob.id)).toBe("none");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a cancel leaves a request accepted since it read it", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.sendConnectionRequest(alice.id, bob.id);
      const cancelled = yield* across(
        h,
        /^delete from "connections"/,
        graph.removeConnection(alice.id, bob.id),
        graph.acceptConnection(bob.id, alice.id),
      );
      expect(cancelled).toBe("Connection not found");
      expect(yield* graph.getConnectionStatus(alice.id, bob.id)).toBe("connected");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("of two unblocks at once, the second answers as a repeat would", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      yield* graph.blockProfile(alice.id, bob.id);
      const second = yield* across(
        h,
        /^delete from "blocks"/,
        graph.unblockProfile(alice.id, bob.id),
        graph.unblockProfile(alice.id, bob.id),
      );
      expect(second).toBe("Block not found");
      expect(yield* graph.isBlocked(alice.id, bob.id)).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a request is refused once the other profile blocks the sender", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const sent = yield* across(
        h,
        /^insert into "connections"/,
        graph.sendConnectionRequest(alice.id, bob.id),
        graph.blockProfile(bob.id, alice.id),
      );
      expect(sent).toBe("Cannot send connection request");
      expect(h.connectionRows()).toBe(0);
      expect(yield* graph.isBlocked(bob.id, alice.id)).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a request is refused once the other profile has sent one the other way", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const sent = yield* across(
        h,
        /^insert into "connections"/,
        graph.sendConnectionRequest(alice.id, bob.id),
        graph.sendConnectionRequest(bob.id, alice.id),
      );
      expect(sent).toBe("Connection already exists");
      expect(h.connectionRows()).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("of two identical requests at once, the second answers as a repeat would", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const second = yield* across(
        h,
        /^insert into "connections"/,
        graph.sendConnectionRequest(alice.id, bob.id),
        graph.sendConnectionRequest(alice.id, bob.id),
      );
      expect(second).toBe("Connection already exists");
      expect(h.connectionRows()).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a block leaves no request that landed while it was being written", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const blocked = yield* across(
        h,
        /^insert into "blocks"/,
        graph.blockProfile(bob.id, alice.id),
        Effect.result(graph.sendConnectionRequest(alice.id, bob.id)),
      );
      expect(blocked).toBe("ok");
      expect(yield* graph.isBlocked(bob.id, alice.id)).toBe(true);
      expect(h.connectionRows()).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });
});
