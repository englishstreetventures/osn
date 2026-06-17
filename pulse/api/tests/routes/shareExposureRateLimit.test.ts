import { generateArcKeyPair } from "@shared/crypto";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createEventsRoutes } from "../../src/routes/events";
import { createTestLayer, seedEvent } from "../helpers/db";

/**
 * P4: per-IP rate limiting on the unauthenticated share / exposure pings,
 * using the hardened `getClientIp` trust policy (S-M34). These tests pin
 * `trustedProxyCount: 1` so the keying IP is taken from `x-forwarded-for`
 * (under `app.handle(...)` there is no socket peer). Fail-closed on a
 * blocking/throwing backend AND on an unresolved IP.
 */

const allow: RateLimiterBackend = { check: () => true };
const block: RateLimiterBackend = { check: () => false };
const throws: RateLimiterBackend = {
  check: () => {
    throw new Error("backend down");
  },
};

const FUTURE = "2030-06-01T10:00:00.000Z";
const PROXIED = { trustedProxyCount: 1 } as const;

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

// POST helper that injects a resolvable client IP (or omits it to exercise
// the fail-closed unresolved-IP path).
const post = (
  app: { handle: (r: Request) => Promise<Response> },
  path: string,
  body: unknown,
  opts: { ip?: string | null; token?: string } = {},
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

// Build an events app with a chosen share + exposure limiter and the
// proxied (resolvable-IP) trust policy.
const buildApp = (
  layer: ReturnType<typeof createTestLayer>,
  share: RateLimiterBackend,
  exposure: RateLimiterBackend,
) => createEventsRoutes(layer, "", testPublicKey, allow, share, exposure, {}, PROXIED);

describe("P4 — per-IP share / exposure rate limiting", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let eventId: string;

  beforeEach(async () => {
    layer = createTestLayer();
    const event = await Effect.runPromise(
      seedEvent({
        title: "Public",
        startTime: FUTURE,
        createdByProfileId: "usr_alice",
        visibility: "public",
      }).pipe(Effect.provide(layer)),
    );
    eventId = event.id;
  });

  it("share: 204 when the limiter allows and the IP resolves", async () => {
    const app = buildApp(layer, allow, allow);
    const res = await post(
      app,
      `/events/${eventId}/share`,
      { source: "whatsapp" },
      {
        ip: "203.0.113.5",
      },
    );
    expect(res.status).toBe(204);
  });

  it("share: 429 when the per-IP limiter blocks", async () => {
    const app = buildApp(layer, block, allow);
    const res = await post(
      app,
      `/events/${eventId}/share`,
      { source: "whatsapp" },
      {
        ip: "203.0.113.5",
      },
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many requests" });
  });

  it("share: 429 (fail-closed) when the limiter backend throws", async () => {
    const app = buildApp(layer, throws, allow);
    const res = await post(
      app,
      `/events/${eventId}/share`,
      { source: "whatsapp" },
      {
        ip: "203.0.113.5",
      },
    );
    expect(res.status).toBe(429);
  });

  it("share: 429 (fail-closed) when the client IP is unresolved", async () => {
    // No x-forwarded-for under trustedProxyCount:1 → UNRESOLVED_IP → deny,
    // even though the limiter would allow. Guards the S-M34 invariant.
    const app = buildApp(layer, allow, allow);
    const res = await post(app, `/events/${eventId}/share`, { source: "whatsapp" });
    expect(res.status).toBe(429);
  });

  it("exposure: 204 when the limiter allows and the IP resolves", async () => {
    const app = buildApp(layer, allow, allow);
    const res = await post(
      app,
      `/events/${eventId}/exposure`,
      { source: "tiktok" },
      {
        ip: "203.0.113.6",
      },
    );
    expect(res.status).toBe(204);
  });

  it("exposure: 429 when the per-IP limiter blocks", async () => {
    const app = buildApp(layer, allow, block);
    const res = await post(
      app,
      `/events/${eventId}/exposure`,
      { source: "tiktok" },
      {
        ip: "203.0.113.6",
      },
    );
    expect(res.status).toBe(429);
  });

  it("exposure: 429 (fail-closed) when the limiter backend throws", async () => {
    const app = buildApp(layer, allow, throws);
    const res = await post(
      app,
      `/events/${eventId}/exposure`,
      { source: "tiktok" },
      {
        ip: "203.0.113.6",
      },
    );
    expect(res.status).toBe(429);
  });

  it("exposure: 429 (fail-closed) when the client IP is unresolved", async () => {
    const app = buildApp(layer, allow, allow);
    const res = await post(app, `/events/${eventId}/exposure`, { source: "tiktok" });
    expect(res.status).toBe(429);
  });

  it("exposure: rate limit is checked before the organiser self-view short-circuit", async () => {
    // A blocking limiter must 429 even the organiser's own ping — the cap is
    // an anti-abuse backstop, not a per-identity exemption.
    const app = buildApp(layer, allow, block);
    const res = await post(
      app,
      `/events/${eventId}/exposure`,
      { source: "x" },
      {
        ip: "203.0.113.6",
        token: await makeToken("usr_alice"),
      },
    );
    expect(res.status).toBe(429);
  });
});
