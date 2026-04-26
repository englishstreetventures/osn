import { generateArcKeyPair } from "@shared/crypto";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createEventsRoutes } from "../../src/routes/events";
import { createTestLayer, seedEvent } from "../helpers/db";

/**
 * Permissive rate limiter for tests — never trips. Real per-IP limiter
 * shape is exercised separately in the rate-limit test below.
 */
const allowAllLimiter: RateLimiterBackend = { check: () => true };

const FUTURE = (ms: number) => new Date(Date.now() + ms).toISOString();

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

describe("GET /events/discover", () => {
  let app: ReturnType<typeof createEventsRoutes>;
  let layer: ReturnType<typeof createTestLayer>;

  beforeEach(() => {
    layer = createTestLayer();
    app = createEventsRoutes(layer, "", testPublicKey, allowAllLimiter);
  });

  it("returns 200 with an empty page when there are no events", async () => {
    const res = await app.handle(new Request("http://localhost/events/discover"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], nextCursor: null, series: {} });
  });

  it("returns public events to anonymous viewers", async () => {
    await Effect.runPromise(
      seedEvent({ title: "Public", startTime: FUTURE(60_000) }).pipe(Effect.provide(layer)),
    );
    const res = await app.handle(new Request("http://localhost/events/discover"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.map((e) => e.title)).toEqual(["Public"]);
  });

  it("hides private events from anonymous viewers", async () => {
    await Effect.runPromise(
      seedEvent({
        title: "Secret",
        startTime: FUTURE(60_000),
        visibility: "private",
      }).pipe(Effect.provide(layer)),
    );
    const res = await app.handle(new Request("http://localhost/events/discover"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], nextCursor: null, series: {} });
  });

  it("returns 401 for friendsOnly without a token", async () => {
    const res = await app.handle(new Request("http://localhost/events/discover?friendsOnly=true"));
    expect(res.status).toBe(401);
  });

  it("returns 422 when lat is provided without lng/radiusKm", async () => {
    const res = await app.handle(new Request("http://localhost/events/discover?lat=51.5"));
    expect(res.status).toBe(422);
  });

  it("returns 422 for priceMin without currency", async () => {
    const res = await app.handle(new Request("http://localhost/events/discover?priceMin=5"));
    expect(res.status).toBe(422);
  });

  it("filters by category via query string", async () => {
    await Effect.runPromise(
      seedEvent({ title: "Show", startTime: FUTURE(60_000), category: "music" }).pipe(
        Effect.provide(layer),
      ),
    );
    await Effect.runPromise(
      seedEvent({ title: "Game", startTime: FUTURE(60_000), category: "sports" }).pipe(
        Effect.provide(layer),
      ),
    );
    const res = await app.handle(new Request("http://localhost/events/discover?category=music"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.map((e) => e.title)).toEqual(["Show"]);
  });

  it("returns 429 when the rate limiter denies the request", async () => {
    const blockingLimiter: RateLimiterBackend = { check: () => false };
    const blockedApp = createEventsRoutes(layer, "", testPublicKey, blockingLimiter);
    const res = await blockedApp.handle(new Request("http://localhost/events/discover"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many requests" });
  });

  it("returns 429 when the rate limiter throws (fail-closed)", async () => {
    const failingLimiter: RateLimiterBackend = {
      check: () => {
        throw new Error("redis down");
      },
    };
    const failedApp = createEventsRoutes(layer, "", testPublicKey, failingLimiter);
    const res = await failedApp.handle(new Request("http://localhost/events/discover"));
    expect(res.status).toBe(429);
  });

  it("returns an authenticated-scope page with a valid cursor shape", async () => {
    await Effect.runPromise(
      seedEvent({ title: "A", startTime: FUTURE(60_000) }).pipe(Effect.provide(layer)),
    );
    const token = await makeToken("usr_alice");
    const res = await app.handle(
      new Request("http://localhost/events/discover?limit=10", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { title: string }[];
      nextCursor: { startTime: string; id: string } | null;
    };
    expect(body.events.map((e) => e.title)).toEqual(["A"]);
    expect(body.nextCursor).not.toBeNull();
    expect(body.nextCursor!.id).toMatch(/^evt_/);
  });
});
