import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { vi, beforeEach } from "vitest";

import {
  addCloseFriend,
  listCloseFriendIds,
  removeCloseFriend,
} from "../../src/services/closeFriends";
import { createTestLayer } from "../helpers/db";

vi.mock("../../src/services/graphBridge", () => ({
  GraphBridgeError: class GraphBridgeError {
    _tag = "GraphBridgeError";
    constructor(public args: { cause: unknown }) {}
  },
  getConnectionIds: vi.fn(() => Effect.succeed(new Set<string>())),
}));

import * as bridge from "../../src/services/graphBridge";

beforeEach(() => {
  vi.mocked(bridge.getConnectionIds).mockReturnValue(Effect.succeed(new Set()));
});

// ---------------------------------------------------------------------------
// addCloseFriend
// ---------------------------------------------------------------------------

it.effect("addCloseFriend inserts a row when the friend is a connection", () =>
  Effect.gen(function* () {
    vi.mocked(bridge.getConnectionIds).mockReturnValue(Effect.succeed(new Set(["usr_bob"])));
    yield* addCloseFriend("usr_alice", "usr_bob");
    const ids = yield* listCloseFriendIds("usr_alice");
    expect(ids).toEqual(["usr_bob"]);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("addCloseFriend is idempotent — duplicate add leaves a single row", () =>
  Effect.gen(function* () {
    vi.mocked(bridge.getConnectionIds).mockReturnValue(Effect.succeed(new Set(["usr_bob"])));
    yield* addCloseFriend("usr_alice", "usr_bob");
    yield* addCloseFriend("usr_alice", "usr_bob");
    const ids = yield* listCloseFriendIds("usr_alice");
    expect(ids).toEqual(["usr_bob"]);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// removeCloseFriend
// ---------------------------------------------------------------------------

it.effect("removeCloseFriend deletes an existing row", () =>
  Effect.gen(function* () {
    vi.mocked(bridge.getConnectionIds).mockReturnValue(Effect.succeed(new Set(["usr_bob"])));
    yield* addCloseFriend("usr_alice", "usr_bob");
    yield* removeCloseFriend("usr_alice", "usr_bob");
    const ids = yield* listCloseFriendIds("usr_alice");
    expect(ids).toEqual([]);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// listCloseFriendIds
// ---------------------------------------------------------------------------

it.effect("listCloseFriendIds returns only the caller's rows", () =>
  Effect.gen(function* () {
    vi.mocked(bridge.getConnectionIds).mockImplementation((profileId) =>
      Effect.succeed(
        profileId === "usr_alice"
          ? new Set(["usr_bob", "usr_carol"])
          : profileId === "usr_dan"
            ? new Set(["usr_bob"])
            : new Set(),
      ),
    );
    yield* addCloseFriend("usr_alice", "usr_bob");
    yield* addCloseFriend("usr_alice", "usr_carol");
    yield* addCloseFriend("usr_dan", "usr_bob");

    const aliceIds = yield* listCloseFriendIds("usr_alice");
    expect(aliceIds.toSorted()).toEqual(["usr_bob", "usr_carol"]);

    const danIds = yield* listCloseFriendIds("usr_dan");
    expect(danIds).toEqual(["usr_bob"]);
  }).pipe(Effect.provide(createTestLayer())),
);
