import { generateArcKeyPair } from "@shared/crypto";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCloseFriendsRoutes } from "../../src/routes/closeFriends";
import { createEventsRoutes } from "../../src/routes/events";
import { createSeriesRoutes } from "../../src/routes/series";
import { createTestLayer, seedEvent } from "../helpers/db";

const block: RateLimiterBackend = { check: () => false };
const throws: RateLimiterBackend = {
  check: () => {
    throw new Error("backend down");
  },
};

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

const FUTURE = "2030-06-01T10:00:00.000Z";

const send = (
  app: { handle: (r: Request) => Promise<Response> },
  method: string,
  path: string,
  token: string,
  body?: unknown,
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );

describe("per-user write rate limiting → 429", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let token: string;

  beforeEach(async () => {
    layer = createTestLayer();
    token = await makeToken("usr_alice");
  });

  it("event create returns 429 when the limiter blocks", async () => {
    const app = createEventsRoutes(layer, "", testPublicKey, undefined, undefined, undefined, {
      eventCreate: block,
    });
    const res = await send(app, "POST", "/events", token, { title: "X", startTime: FUTURE });
    expect(res.status).toBe(429);
  });

  it("event create fails closed (429) when the limiter throws", async () => {
    const app = createEventsRoutes(layer, "", testPublicKey, undefined, undefined, undefined, {
      eventCreate: throws,
    });
    const res = await send(app, "POST", "/events", token, { title: "X", startTime: FUTURE });
    expect(res.status).toBe(429);
  });

  it("event update returns 429 when the limiter blocks", async () => {
    const event = await Effect.runPromise(
      seedEvent({ title: "E", startTime: FUTURE, createdByProfileId: "usr_alice" }).pipe(
        Effect.provide(layer),
      ),
    );
    const app = createEventsRoutes(layer, "", testPublicKey, undefined, undefined, undefined, {
      eventUpdate: block,
    });
    const res = await send(app, "PATCH", `/events/${event.id}`, token, { title: "Y" });
    expect(res.status).toBe(429);
  });

  it("RSVP upsert returns 429 when the limiter blocks", async () => {
    const event = await Effect.runPromise(
      seedEvent({ title: "E", startTime: FUTURE }).pipe(Effect.provide(layer)),
    );
    const app = createEventsRoutes(layer, "", testPublicKey, undefined, undefined, undefined, {
      rsvpUpsert: block,
    });
    const res = await send(app, "POST", `/events/${event.id}/rsvps`, token, { status: "going" });
    expect(res.status).toBe(429);
  });

  it("invite returns 429 when the limiter blocks", async () => {
    const event = await Effect.runPromise(
      seedEvent({ title: "E", startTime: FUTURE, createdByProfileId: "usr_alice" }).pipe(
        Effect.provide(layer),
      ),
    );
    const app = createEventsRoutes(layer, "", testPublicKey, undefined, undefined, undefined, {
      eventInvite: block,
    });
    const res = await send(app, "POST", `/events/${event.id}/invite`, token, {
      profileIds: ["usr_bob"],
    });
    expect(res.status).toBe(429);
  });

  it("comms blast returns 429 when the limiter blocks", async () => {
    const event = await Effect.runPromise(
      seedEvent({ title: "E", startTime: FUTURE, createdByProfileId: "usr_alice" }).pipe(
        Effect.provide(layer),
      ),
    );
    const app = createEventsRoutes(layer, "", testPublicKey, undefined, undefined, undefined, {
      commsBlast: block,
    });
    const res = await send(app, "POST", `/events/${event.id}/comms/blasts`, token, {
      channels: ["email"],
      body: "hi",
    });
    expect(res.status).toBe(429);
  });

  it("series create returns 429 when the limiter blocks", async () => {
    const app = createSeriesRoutes(layer, "", testPublicKey, { seriesCreate: block });
    const res = await send(app, "POST", "/series", token, {
      title: "S",
      rrule: "FREQ=WEEKLY;COUNT=3",
      dtstart: FUTURE,
    });
    expect(res.status).toBe(429);
  });

  it("series patch returns 429 when the limiter blocks", async () => {
    const app = createSeriesRoutes(layer, "", testPublicKey, { seriesUpdate: block });
    const res = await send(app, "PATCH", "/series/ser_nope", token, { title: "T" });
    expect(res.status).toBe(429);
  });

  it("close-friend add returns 429 when the limiter blocks", async () => {
    const app = createCloseFriendsRoutes(layer, "", testPublicKey, block);
    const res = await send(app, "POST", "/close-friends/usr_bob", token);
    expect(res.status).toBe(429);
  });

  it("close-friend remove fails closed (429) when the limiter throws", async () => {
    const app = createCloseFriendsRoutes(layer, "", testPublicKey, throws);
    const res = await send(app, "DELETE", "/close-friends/usr_bob", token);
    expect(res.status).toBe(429);
  });

  it("does not rate-limit before authenticating (401 wins for anon)", async () => {
    const app = createEventsRoutes(layer, "", testPublicKey, undefined, undefined, undefined, {
      eventCreate: block,
    });
    const res = await app.handle(
      new Request("http://localhost/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "X", startTime: FUTURE }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
