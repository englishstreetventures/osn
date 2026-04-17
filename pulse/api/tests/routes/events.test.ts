import { generateArcKeyPair } from "@shared/crypto";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createEventsRoutes } from "../../src/routes/events";
import { createTestLayer, seedEvent } from "../helpers/db";

const FUTURE = "2030-06-01T10:00:00.000Z";

let testPrivateKey: CryptoKey;
let testPublicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateArcKeyPair();
  testPrivateKey = pair.privateKey;
  testPublicKey = pair.publicKey;
});

async function makeToken(profileId: string, email?: string): Promise<string> {
  const payload: Record<string, string> = { sub: profileId };
  if (email) payload.email = email;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
    .sign(testPrivateKey);
}

const json = (body: unknown) => JSON.stringify(body);
const post = (
  app: ReturnType<typeof createEventsRoutes>,
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
      body: json(body),
    }),
  );
const patch = (
  app: ReturnType<typeof createEventsRoutes>,
  path: string,
  body: unknown,
  token?: string,
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: json(body),
    }),
  );
const del = (app: ReturnType<typeof createEventsRoutes>, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

describe("events routes", () => {
  let app: ReturnType<typeof createEventsRoutes>;
  let layer: ReturnType<typeof createTestLayer>;
  let aliceToken: string;

  beforeEach(async () => {
    layer = createTestLayer();
    app = createEventsRoutes(layer, "", testPublicKey);
    aliceToken = await makeToken("usr_alice");
  });

  it("GET /events returns 200 empty list", async () => {
    const res = await app.handle(new Request("http://localhost/events"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });

  it("GET /events/today returns 200 empty list", async () => {
    const res = await app.handle(new Request("http://localhost/events/today"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });

  it("GET /events/:id returns 404 for missing event", async () => {
    const res = await app.handle(new Request("http://localhost/events/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("POST /events returns 401 when not authenticated", async () => {
    const res = await post(app, "/events", { title: "Concert", startTime: FUTURE });
    expect(res.status).toBe(401);
  });

  it("POST /events creates event and returns 201", async () => {
    const res = await post(app, "/events", { title: "Concert", startTime: FUTURE }, aliceToken);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { id: string; title: string } };
    expect(body.event.id).toMatch(/^evt_/);
    expect(body.event.title).toBe("Concert");
  });

  it("POST /events returns 422 for missing title", async () => {
    const res = await post(app, "/events", { startTime: FUTURE }, aliceToken);
    expect(res.status).toBe(422);
  });

  it("POST /events returns 422 for empty title", async () => {
    const res = await post(app, "/events", { title: "", startTime: FUTURE }, aliceToken);
    expect(res.status).toBe(422);
  });

  it("POST /events returns 422 for invalid imageUrl", async () => {
    const res = await post(
      app,
      "/events",
      {
        title: "Concert",
        startTime: FUTURE,
        imageUrl: "not-a-url",
      },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });

  it("POST /events accepts valid imageUrl", async () => {
    const res = await post(
      app,
      "/events",
      {
        title: "Concert",
        startTime: FUTURE,
        imageUrl: "https://example.com/image.jpg",
      },
      aliceToken,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { imageUrl: string } };
    expect(body.event.imageUrl).toBe("https://example.com/image.jpg");
  });

  it("PATCH /events/:id updates event and returns 200", async () => {
    const createRes = await post(
      app,
      "/events",
      { title: "Original", startTime: FUTURE },
      aliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await patch(app, `/events/${event.id}`, { title: "Updated" }, aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { title: string } };
    expect(body.event.title).toBe("Updated");
  });

  it("PATCH /events/:id returns 404 for nonexistent event", async () => {
    const res = await patch(app, "/events/nonexistent", { title: "Updated" }, aliceToken);
    expect(res.status).toBe(404);
  });

  it("PATCH /events/:id returns 422 for invalid imageUrl", async () => {
    const createRes = await post(
      app,
      "/events",
      { title: "Original", startTime: FUTURE },
      aliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await patch(app, `/events/${event.id}`, { imageUrl: "not-a-url" }, aliceToken);
    expect(res.status).toBe(422);
  });

  it("DELETE /events/:id returns 204", async () => {
    const createRes = await post(
      app,
      "/events",
      { title: "To Delete", startTime: FUTURE },
      aliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await del(app, `/events/${event.id}`, aliceToken);
    expect(res.status).toBe(204);
  });

  it("DELETE /events/:id returns 404 for nonexistent event", async () => {
    const res = await del(app, "/events/nonexistent", aliceToken);
    expect(res.status).toBe(404);
  });

  it("GET /events/:id returns 200 with event body", async () => {
    const createRes = await post(
      app,
      "/events",
      { title: "My Event", startTime: FUTURE },
      aliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await app.handle(new Request(`http://localhost/events/${event.id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { title: string } };
    expect(body.event.title).toBe("My Event");
  });

  it("GET /events?status=upcoming filters results", async () => {
    const STARTED = new Date(Date.now() - 60_000);
    await post(app, "/events", { title: "Upcoming Event", startTime: FUTURE }, aliceToken);
    await Effect.runPromise(
      seedEvent({ title: "Ongoing Event", startTime: STARTED, status: "ongoing" }).pipe(
        Effect.provide(layer),
      ),
    );
    const res = await app.handle(new Request("http://localhost/events?status=upcoming"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.every((e) => e.title === "Upcoming Event")).toBe(true);
    expect(body.events.length).toBe(1);
  });

  it("POST /events returns 422 when startTime is in the past", async () => {
    const PAST = "2020-01-01T10:00:00.000Z";
    const res = await post(app, "/events", { title: "Past", startTime: PAST }, aliceToken);
    expect(res.status).toBe(422);
  });

  it("GET /events?limit=1 returns at most 1 event", async () => {
    await post(app, "/events", { title: "Event A", startTime: FUTURE }, aliceToken);
    await post(app, "/events", { title: "Event B", startTime: FUTURE }, aliceToken);
    const res = await app.handle(new Request("http://localhost/events?limit=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events.length).toBe(1);
  });

  it("GET /events?category=music filters by category", async () => {
    await post(
      app,
      "/events",
      { title: "Music Night", startTime: FUTURE, category: "music" },
      aliceToken,
    );
    await post(
      app,
      "/events",
      { title: "Sports Day", startTime: FUTURE, category: "sports" },
      aliceToken,
    );
    const res = await app.handle(new Request("http://localhost/events?category=music"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.length).toBe(1);
    expect(body.events[0]!.title).toBe("Music Night");
  });

  it("PATCH /events/:id returns 422 for invalid startTime", async () => {
    const createRes = await post(
      app,
      "/events",
      { title: "Original", startTime: FUTURE },
      aliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await patch(app, `/events/${event.id}`, { startTime: "not-a-date" }, aliceToken);
    expect(res.status).toBe(422);
  });

  it("PATCH /events/:id returns 422 for invalid endTime", async () => {
    const createRes = await post(
      app,
      "/events",
      { title: "Original", startTime: FUTURE },
      aliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await patch(app, `/events/${event.id}`, { endTime: "not-a-date" }, aliceToken);
    expect(res.status).toBe(422);
  });

  // ── Ownership ──────────────────────────────────────────────────────────────

  it("POST /events stores createdByProfileId from JWT; derives createdByName from email claim", async () => {
    const token = await makeToken("usr_alice", "alice@example.com");
    const res = await post(app, "/events", { title: "My Event", startTime: FUTURE }, token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: { createdByProfileId: string; createdByName: string };
    };
    expect(body.event.createdByProfileId).toBe("usr_alice");
    expect(body.event.createdByName).toBe("alice");
  });

  it("DELETE /events/:id returns 403 when requester does not own the event", async () => {
    const localAliceToken = await makeToken("usr_alice");
    const bobToken = await makeToken("usr_bob");
    const createRes = await post(
      app,
      "/events",
      { title: "Alice's Event", startTime: FUTURE },
      localAliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await del(app, `/events/${event.id}`, bobToken);
    expect(res.status).toBe(403);
  });

  it("DELETE /events/:id returns 204 when requester owns the event", async () => {
    const token = await makeToken("usr_alice");
    const createRes = await post(app, "/events", { title: "Mine", startTime: FUTURE }, token);
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await del(app, `/events/${event.id}`, token);
    expect(res.status).toBe(204);
  });

  it("PATCH /events/:id returns 403 when requester does not own the event", async () => {
    const localAliceToken = await makeToken("usr_alice");
    const bobToken = await makeToken("usr_bob");
    const createRes = await post(
      app,
      "/events",
      { title: "Alice's Event", startTime: FUTURE },
      localAliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await patch(app, `/events/${event.id}`, { title: "Hijacked" }, bobToken);
    expect(res.status).toBe(403);
  });

  it("PATCH /events/:id returns 200 when requester owns the event", async () => {
    const createRes = await post(app, "/events", { title: "Mine", startTime: FUTURE }, aliceToken);
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await patch(app, `/events/${event.id}`, { title: "Updated Mine" }, aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { title: string } };
    expect(body.event.title).toBe("Updated Mine");
  });

  it("PATCH /events/:id returns 401 when no auth token provided", async () => {
    const createRes = await post(app, "/events", { title: "Mine", startTime: FUTURE }, aliceToken);
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await patch(app, `/events/${event.id}`, { title: "Hijack" });
    expect(res.status).toBe(401);
  });

  it("DELETE /events/:id returns 401 when no auth token provided", async () => {
    const createRes = await post(app, "/events", { title: "Mine", startTime: FUTURE }, aliceToken);
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await del(app, `/events/${event.id}`);
    expect(res.status).toBe(401);
  });
});
