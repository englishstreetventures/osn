import { generateArcKeyPair } from "@shared/crypto";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

import { createCloseFriendsRoutes } from "../../src/routes/closeFriends";
import { createTestLayer, seedCloseFriend } from "../helpers/db";

vi.mock("../../src/services/graphBridge", () => ({
  GraphBridgeError: class GraphBridgeError {
    _tag = "GraphBridgeError";
    constructor(public args: { cause: unknown }) {}
  },
  getConnectionIds: vi.fn(() => Effect.succeed(new Set<string>())),
  getProfileDisplays: vi.fn(() => Effect.succeed(new Map())),
}));

import * as bridge from "../../src/services/graphBridge";

let testPrivateKey: CryptoKey;
let testPublicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateArcKeyPair();
  testPrivateKey = pair.privateKey;
  testPublicKey = pair.publicKey;
});

async function makeToken(profileId: string): Promise<string> {
  return new SignJWT({ sub: profileId })
    .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
    .sign(testPrivateKey);
}

const post = (app: ReturnType<typeof createCloseFriendsRoutes>, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
const del = (app: ReturnType<typeof createCloseFriendsRoutes>, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
const get = (app: ReturnType<typeof createCloseFriendsRoutes>, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

describe("close-friends routes", () => {
  let app: ReturnType<typeof createCloseFriendsRoutes>;
  let layer: ReturnType<typeof createTestLayer>;
  let aliceToken: string;

  beforeEach(async () => {
    layer = createTestLayer();
    app = createCloseFriendsRoutes(layer, "", testPublicKey);
    aliceToken = await makeToken("usr_alice");
    vi.mocked(bridge.getConnectionIds).mockReturnValue(Effect.succeed(new Set()));
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(Effect.succeed(new Map()));
  });

  it("rejects unauthenticated requests on every route", async () => {
    expect((await get(app, "/close-friends")).status).toBe(401);
    expect((await post(app, "/close-friends/usr_bob")).status).toBe(401);
    expect((await del(app, "/close-friends/usr_bob")).status).toBe(401);
    expect((await get(app, "/close-friends/usr_bob/check")).status).toBe(401);
  });

  it("POST /close-friends/:friendId 201 on success", async () => {
    vi.mocked(bridge.getConnectionIds).mockReturnValue(Effect.succeed(new Set(["usr_bob"])));
    const res = await post(app, "/close-friends/usr_bob", aliceToken);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /close-friends/:friendId 422 on self-add", async () => {
    const res = await post(app, "/close-friends/usr_alice", aliceToken);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "self" });
  });

  it("POST /close-friends/:friendId 422 when not connected", async () => {
    vi.mocked(bridge.getConnectionIds).mockReturnValue(Effect.succeed(new Set()));
    const res = await post(app, "/close-friends/usr_bob", aliceToken);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_a_connection" });
  });

  it("DELETE /close-friends/:friendId 200 on success, 404 when missing", async () => {
    await Effect.runPromise(seedCloseFriend("usr_alice", "usr_bob").pipe(Effect.provide(layer)));
    const ok = await del(app, "/close-friends/usr_bob", aliceToken);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    const missing = await del(app, "/close-friends/usr_carol", aliceToken);
    expect(missing.status).toBe(404);
  });

  it("GET /close-friends returns the caller's list joined with profile displays", async () => {
    await Effect.runPromise(
      Effect.all([
        seedCloseFriend("usr_alice", "usr_bob"),
        seedCloseFriend("usr_alice", "usr_carol"),
      ]).pipe(Effect.provide(layer)),
    );
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(
        new Map([
          ["usr_bob", { id: "usr_bob", handle: "bob", displayName: "Bob", avatarUrl: null }],
          [
            "usr_carol",
            { id: "usr_carol", handle: "carol", displayName: "Carol", avatarUrl: null },
          ],
        ]),
      ),
    );
    const res = await get(app, "/close-friends", aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      closeFriends: Array<{ profileId: string; handle: string | null }>;
    };
    expect(body.closeFriends.map((c) => c.profileId).toSorted()).toEqual(["usr_bob", "usr_carol"]);
    expect(body.closeFriends.find((c) => c.profileId === "usr_bob")?.handle).toBe("bob");
  });

  it("GET /close-friends/:friendId/check returns the boolean", async () => {
    await Effect.runPromise(seedCloseFriend("usr_alice", "usr_bob").pipe(Effect.provide(layer)));
    const yes = await get(app, "/close-friends/usr_bob/check", aliceToken);
    expect(await yes.json()).toEqual({ isCloseFriend: true });
    const no = await get(app, "/close-friends/usr_carol/check", aliceToken);
    expect(await no.json()).toEqual({ isCloseFriend: false });
  });
});
