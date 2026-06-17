import { generateArcKeyPair } from "@shared/crypto";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createEventsRoutes } from "../../src/routes/events";
import { canViewAttendees } from "../../src/services/eventAccess";
import { createTestLayer, seedEvent } from "../helpers/db";

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

const get = (app: { handle: (r: Request) => Promise<Response> }, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

describe("canViewAttendees policy", () => {
  it("is true only for the organiser", () => {
    const event = { createdByProfileId: "usr_alice" };
    expect(canViewAttendees(event, "usr_alice")).toBe(true);
    expect(canViewAttendees(event, "usr_bob")).toBe(false);
    expect(canViewAttendees(event, null)).toBe(false);
  });
});

describe("GET /events/:id/rsvps — additive canViewAttendees flag", () => {
  let app: ReturnType<typeof createEventsRoutes>;
  let layer: ReturnType<typeof createTestLayer>;
  let eventId: string;

  beforeEach(async () => {
    layer = createTestLayer();
    app = createEventsRoutes(layer, "", testPublicKey);
    const event = await Effect.runPromise(
      seedEvent({
        title: "Public",
        startTime: "2030-06-01T10:00:00.000Z",
        createdByProfileId: "usr_alice",
        visibility: "public",
      }).pipe(Effect.provide(layer)),
    );
    eventId = event.id;
  });

  it("returns canViewAttendees=true for the organiser", async () => {
    const res = await get(app, `/events/${eventId}/rsvps`, await makeToken("usr_alice"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canViewAttendees: boolean };
    expect(body.canViewAttendees).toBe(true);
  });

  it("returns canViewAttendees=false for a non-organiser viewer", async () => {
    const res = await get(app, `/events/${eventId}/rsvps`, await makeToken("usr_bob"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canViewAttendees: boolean };
    expect(body.canViewAttendees).toBe(false);
  });

  it("returns canViewAttendees=false for an anonymous viewer (public event)", async () => {
    const res = await get(app, `/events/${eventId}/rsvps`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rsvps: unknown[]; canViewAttendees: boolean };
    expect(body.canViewAttendees).toBe(false);
    // Additive: the existing `rsvps` array is still present + unchanged shape.
    expect(Array.isArray(body.rsvps)).toBe(true);
  });

  it("exposes the same flag on /rsvps/latest", async () => {
    const res = await get(app, `/events/${eventId}/rsvps/latest`, await makeToken("usr_alice"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canViewAttendees: boolean };
    expect(body.canViewAttendees).toBe(true);
  });
});
