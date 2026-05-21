import { generateArcKeyPair } from "@shared/crypto";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

import { createOnboardingRoutes } from "../../src/routes/onboarding";
import { createTestLayer } from "../helpers/db";

vi.mock("../../src/services/graphBridge", () => ({
  GraphBridgeError: class GraphBridgeError {
    _tag = "GraphBridgeError";
    constructor(public args: { cause: unknown }) {}
  },
  ProfileNotFoundError: class ProfileNotFoundError {
    _tag = "ProfileNotFoundError";
    constructor(public args: { profileId: string }) {}
  },
  getAccountIdForProfile: vi.fn(() => Effect.succeed("acc_default")),
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

const get = (app: ReturnType<typeof createOnboardingRoutes>, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

const post = (
  app: ReturnType<typeof createOnboardingRoutes>,
  path: string,
  body: unknown,
  token?: string,
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const validBody = {
  interests: ["music", "food"],
  notificationsOptIn: true,
  eventRemindersOptIn: false,
  notificationsPerm: "granted" as const,
  locationPerm: "granted" as const,
};

describe("onboarding routes", () => {
  let app: ReturnType<typeof createOnboardingRoutes>;
  let aliceToken: string;

  beforeEach(async () => {
    const layer = createTestLayer();
    app = createOnboardingRoutes(layer, "", testPublicKey);
    aliceToken = await makeToken("usr_alice");
    vi.mocked(bridge.getAccountIdForProfile).mockReturnValue(Effect.succeed("acc_alice"));
  });

  // -------------------------------------------------------------------------
  // Auth gate
  // -------------------------------------------------------------------------

  it("rejects unauthenticated GET with 401", async () => {
    const res = await get(app, "/me/onboarding");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated POST with 401", async () => {
    const res = await post(app, "/me/onboarding/complete", validBody);
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // GET /me/onboarding
  // -------------------------------------------------------------------------

  it("GET returns defaults for a fresh account", async () => {
    const res = await get(app, "/me/onboarding", aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.completedAt).toBeNull();
    expect(body.interests).toEqual([]);
    expect(body.notificationsOptIn).toBe(false);
    expect(body.eventRemindersOptIn).toBe(false);
    expect(body.notificationsPerm).toBe("prompt");
    expect(body.locationPerm).toBe("prompt");
  });

  it("GET response never carries accountId (privacy invariant)", async () => {
    const res = await get(app, "/me/onboarding", aliceToken);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("accountId");
    expect(body).not.toHaveProperty("account_id");
  });

  // -------------------------------------------------------------------------
  // POST /me/onboarding/complete
  // -------------------------------------------------------------------------

  it("POST accepts a valid payload and returns the persisted state", async () => {
    const res = await post(app, "/me/onboarding/complete", validBody, aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.completedAt).toBe("string");
    expect(body.interests).toEqual(["music", "food"]);
    expect(body.notificationsOptIn).toBe(true);
    expect(body.notificationsPerm).toBe("granted");
  });

  it("POST is idempotent — second call returns the original completedAt", async () => {
    const first = await post(app, "/me/onboarding/complete", validBody, aliceToken);
    const second = await post(
      app,
      "/me/onboarding/complete",
      { ...validBody, interests: ["arts"], notificationsOptIn: false },
      aliceToken,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as Record<string, unknown>;
    const b = (await second.json()) as Record<string, unknown>;
    expect(b.completedAt).toBe(a.completedAt);
    // Original interests preserved.
    expect(b.interests).toEqual(["music", "food"]);
  });

  it("POST 422 on unknown interest category", async () => {
    const res = await post(
      app,
      "/me/onboarding/complete",
      { ...validBody, interests: ["definitely_not"] },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });

  it("POST 422 on too many interests", async () => {
    const res = await post(
      app,
      "/me/onboarding/complete",
      {
        ...validBody,
        interests: [
          "music",
          "food",
          "sports",
          "arts",
          "tech",
          "community",
          "education",
          "social",
          "nightlife",
        ],
      },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });

  it("POST 422 on missing required field", async () => {
    const res = await post(
      app,
      "/me/onboarding/complete",
      { interests: [], notificationsOptIn: true },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });

  it("POST response never carries accountId (privacy invariant)", async () => {
    const res = await post(app, "/me/onboarding/complete", validBody, aliceToken);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("accountId");
    expect(body).not.toHaveProperty("account_id");
  });

  // -------------------------------------------------------------------------
  // Bridge failure path
  // -------------------------------------------------------------------------

  it("GET 503 when the bridge is unreachable (GraphBridgeError → infra failure)", async () => {
    vi.mocked(bridge.getAccountIdForProfile).mockReturnValueOnce(
      Effect.fail(new bridge.GraphBridgeError({ cause: new Error("upstream") })),
    );
    const res = await get(app, "/me/onboarding", aliceToken);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("unavailable") });
  });

  it("GET 401 when the bridge reports the profile doesn't exist (vs. 503 for infra)", async () => {
    vi.mocked(bridge.getAccountIdForProfile).mockReturnValueOnce(
      Effect.fail(new bridge.ProfileNotFoundError({ profileId: "usr_alice" })),
    );
    const res = await get(app, "/me/onboarding", aliceToken);
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Resolver cache — verifies the second request hits the local mapping
  // table rather than re-calling the bridge. Privacy + latency-relevant.
  // -------------------------------------------------------------------------

  it("second GET hits the profile→account cache (does not re-call the bridge)", async () => {
    vi.mocked(bridge.getAccountIdForProfile).mockClear();
    await get(app, "/me/onboarding", aliceToken);
    await get(app, "/me/onboarding", aliceToken);
    expect(vi.mocked(bridge.getAccountIdForProfile)).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Rate limiter
  // -------------------------------------------------------------------------

  it("POST 429 when the rate limiter rejects", async () => {
    const layer = createTestLayer();
    const denyAll = {
      check: () => Promise.resolve(false),
      reset: () => Promise.resolve(),
    };
    const denyApp = createOnboardingRoutes(layer, "", testPublicKey, denyAll);
    const res = await post(denyApp, "/me/onboarding/complete", validBody, aliceToken);
    expect(res.status).toBe(429);
  });

  it("GET 429 when the status rate limiter rejects (S-M2)", async () => {
    const layer = createTestLayer();
    const allowAll = { check: () => Promise.resolve(true), reset: () => Promise.resolve() };
    const denyAll = { check: () => Promise.resolve(false), reset: () => Promise.resolve() };
    const denyApp = createOnboardingRoutes(layer, "", testPublicKey, allowAll, denyAll);
    const res = await get(denyApp, "/me/onboarding", aliceToken);
    expect(res.status).toBe(429);
  });

  it("GET 429 fail-closed when the status rate limiter throws (S-M2)", async () => {
    const layer = createTestLayer();
    const allowAll = { check: () => Promise.resolve(true), reset: () => Promise.resolve() };
    const throwing = {
      check: () => Promise.reject(new Error("backend down")),
      reset: () => Promise.resolve(),
    };
    const failApp = createOnboardingRoutes(layer, "", testPublicKey, allowAll, throwing);
    const res = await get(failApp, "/me/onboarding", aliceToken);
    expect(res.status).toBe(429);
  });
});
