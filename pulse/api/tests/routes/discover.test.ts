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

/**
 * Trust policy used by these tests: pretend pulse-api sits behind a single
 * proxy so the per-IP limiter can resolve a keying IP from the injected
 * `x-forwarded-for` header (under `app.handle(...)` there is no socket peer,
 * so direct mode would resolve to UNRESOLVED → fail-closed 429). Matches the
 * osn/api auth-route test convention.
 */
const TEST_IP_CONFIG = { trustedProxyCount: 1 } as const;

/** Inject a stable client IP so the per-IP limiter resolves under TEST_IP_CONFIG. */
const withIp = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { "x-forwarded-for": "203.0.113.7", ...(init.headers as Record<string, string>) },
});

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
    .setAudience("osn-access")
    .sign(testPrivateKey);
}

describe("GET /events/discover", () => {
  let app: ReturnType<typeof createEventsRoutes>;
  let layer: ReturnType<typeof createTestLayer>;

  beforeEach(() => {
    layer = createTestLayer();
    app = createEventsRoutes(
      layer,
      "",
      testPublicKey,
      allowAllLimiter,
      undefined,
      undefined,
      undefined,
      TEST_IP_CONFIG,
    );
  });

  it("returns 200 with an empty page when there are no events", async () => {
    const res = await app.handle(new Request("http://localhost/events/discover", withIp()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], nextCursor: null, series: {} });
  });

  it("returns public events to anonymous viewers", async () => {
    await Effect.runPromise(
      seedEvent({ title: "Public", startTime: FUTURE(60_000) }).pipe(Effect.provide(layer)),
    );
    const res = await app.handle(new Request("http://localhost/events/discover", withIp()));
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
    const res = await app.handle(new Request("http://localhost/events/discover", withIp()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], nextCursor: null, series: {} });
  });

  it("returns 401 for friendsOnly without a token", async () => {
    const res = await app.handle(
      new Request("http://localhost/events/discover?friendsOnly=true", withIp()),
    );
    expect(res.status).toBe(401);
  });

  it("returns 422 when lat is provided without lng/radiusKm", async () => {
    const res = await app.handle(
      new Request("http://localhost/events/discover?lat=51.5", withIp()),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 for priceMin without currency", async () => {
    const res = await app.handle(
      new Request("http://localhost/events/discover?priceMin=5", withIp()),
    );
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
    const res = await app.handle(
      new Request("http://localhost/events/discover?category=music", withIp()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.map((e) => e.title)).toEqual(["Show"]);
  });

  it("returns 429 when the rate limiter denies the request", async () => {
    const blockingLimiter: RateLimiterBackend = { check: () => false };
    const blockedApp = createEventsRoutes(
      layer,
      "",
      testPublicKey,
      blockingLimiter,
      undefined,
      undefined,
      undefined,
      TEST_IP_CONFIG,
    );
    const res = await blockedApp.handle(new Request("http://localhost/events/discover", withIp()));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many requests" });
  });

  it("returns 429 when the rate limiter throws (fail-closed)", async () => {
    const failingLimiter: RateLimiterBackend = {
      check: () => {
        throw new Error("redis down");
      },
    };
    const failedApp = createEventsRoutes(
      layer,
      "",
      testPublicKey,
      failingLimiter,
      undefined,
      undefined,
      undefined,
      TEST_IP_CONFIG,
    );
    const res = await failedApp.handle(new Request("http://localhost/events/discover", withIp()));
    expect(res.status).toBe(429);
  });

  it("returns 429 when the client IP cannot be resolved (fail-closed)", async () => {
    // No x-forwarded-for under trustedProxyCount:1 → UNRESOLVED_IP → deny,
    // even though the limiter itself would allow. Guards the S-M34 invariant
    // that an unresolved IP never shares a bucket.
    const res = await app.handle(new Request("http://localhost/events/discover"));
    expect(res.status).toBe(429);
  });

  it("returns an authenticated-scope page with a valid cursor shape", async () => {
    await Effect.runPromise(
      seedEvent({ title: "A", startTime: FUTURE(60_000) }).pipe(Effect.provide(layer)),
    );
    const token = await makeToken("usr_alice");
    const res = await app.handle(
      new Request(
        "http://localhost/events/discover?limit=10",
        withIp({ headers: { Authorization: `Bearer ${token}` } }),
      ),
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
