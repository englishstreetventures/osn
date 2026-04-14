import { SignJWT } from "jose";
import { describe, it, expect, beforeEach } from "vitest";

import { createEventsRoutes, createSettingsRoutes } from "../../src/routes/events";
import { createTestLayer } from "../helpers/db";
import { createOsnTestContext, seedOsnUser } from "../helpers/osnDb";

const FUTURE = "2030-06-01T10:00:00.000Z";
const TEST_JWT_SECRET = "test-secret";

async function makeToken(profileId: string): Promise<string> {
  return new SignJWT({ sub: profileId })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
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
const get = (app: ReturnType<typeof createEventsRoutes>, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
const patch = (
  app: ReturnType<typeof createSettingsRoutes>,
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

describe("events routes — new config fields", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let osn: ReturnType<typeof createOsnTestContext>;
  let app: ReturnType<typeof createEventsRoutes>;
  let aliceToken: string;

  beforeEach(async () => {
    layer = createTestLayer();
    osn = createOsnTestContext();
    app = createEventsRoutes(layer, TEST_JWT_SECRET, osn.layer);
    aliceToken = await makeToken("usr_alice");
    await seedOsnUser(osn, { id: "usr_alice", handle: "alice", displayName: "Alice" });
    await seedOsnUser(osn, { id: "usr_bob", handle: "bob", displayName: "Bob" });
  });

  it("POST /events accepts visibility + guestListVisibility + joinPolicy + allowInterested + commsChannels", async () => {
    const res = await post(
      app,
      "/events",
      {
        title: "Configured Event",
        startTime: FUTURE,
        visibility: "private",
        guestListVisibility: "connections",
        joinPolicy: "guest_list",
        allowInterested: false,
        commsChannels: ["sms", "email"],
      },
      aliceToken,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: {
        visibility: string;
        guestListVisibility: string;
        joinPolicy: string;
        allowInterested: boolean;
        commsChannels: string;
      };
    };
    expect(body.event.visibility).toBe("private");
    expect(body.event.guestListVisibility).toBe("connections");
    expect(body.event.joinPolicy).toBe("guest_list");
    expect(body.event.allowInterested).toBe(false);
    expect(JSON.parse(body.event.commsChannels)).toEqual(["sms", "email"]);
  });

  it("POST /events rejects empty commsChannels", async () => {
    const res = await post(
      app,
      "/events",
      { title: "Event", startTime: FUTURE, commsChannels: [] },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });

  it("GET /events filters out private events from discovery for other users", async () => {
    const bobToken = await makeToken("usr_bob");
    // Alice creates a private event
    await post(
      app,
      "/events",
      { title: "Private Party", startTime: FUTURE, visibility: "private" },
      aliceToken,
    );
    // Bob's feed should not include it
    const res = await get(app, "/events", bobToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events).toEqual([]);
  });

  it("GET /events still shows Alice her own private events", async () => {
    await post(
      app,
      "/events",
      { title: "My Private Party", startTime: FUTURE, visibility: "private" },
      aliceToken,
    );
    const res = await get(app, "/events", aliceToken);
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.title).toBe("My Private Party");
  });

  it("GET /events includes public events for everyone", async () => {
    await post(app, "/events", { title: "Public Event", startTime: FUTURE }, aliceToken);
    const res = await get(app, "/events");
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.map((e) => e.title)).toContain("Public Event");
  });
});

describe("RSVP routes", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let osn: ReturnType<typeof createOsnTestContext>;
  let app: ReturnType<typeof createEventsRoutes>;
  let aliceToken: string;
  let bobToken: string;
  let eventId: string;

  beforeEach(async () => {
    layer = createTestLayer();
    osn = createOsnTestContext();
    app = createEventsRoutes(layer, TEST_JWT_SECRET, osn.layer);
    aliceToken = await makeToken("usr_alice");
    bobToken = await makeToken("usr_bob");
    await seedOsnUser(osn, { id: "usr_alice", handle: "alice", displayName: "Alice" });
    await seedOsnUser(osn, { id: "usr_bob", handle: "bob", displayName: "Bob" });
    const res = await post(app, "/events", { title: "Party", startTime: FUTURE }, aliceToken);
    const body = (await res.json()) as { event: { id: string } };
    eventId = body.event.id;
  });

  it("POST /events/:id/rsvps creates RSVP and returns 200", async () => {
    const res = await post(app, `/events/${eventId}/rsvps`, { status: "going" }, bobToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rsvp: { status: string; profileId: string } };
    expect(body.rsvp.status).toBe("going");
    expect(body.rsvp.profileId).toBe("usr_bob");
  });

  it("POST /events/:id/rsvps returns 401 when unauthenticated", async () => {
    const res = await post(app, `/events/${eventId}/rsvps`, { status: "going" });
    expect(res.status).toBe(401);
  });

  it("POST /events/:id/rsvps returns 422 for invalid status", async () => {
    const res = await post(
      app,
      `/events/${eventId}/rsvps`,
      { status: "maybe" as unknown as "going" },
      bobToken,
    );
    expect(res.status).toBe(422);
  });

  it("POST /events/:id/rsvps returns 404 for missing event", async () => {
    const res = await post(app, "/events/evt_missing/rsvps", { status: "going" }, bobToken);
    expect(res.status).toBe(404);
  });

  it("GET /events/:id/rsvps/counts returns counts grouped by status", async () => {
    await post(app, `/events/${eventId}/rsvps`, { status: "going" }, bobToken);
    const res = await get(app, `/events/${eventId}/rsvps/counts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { going: number; interested: number; not_going: number; invited: number };
    };
    expect(body.counts.going).toBe(1);
    expect(body.counts.interested).toBe(0);
  });

  it("GET /events/:id/rsvps returns public rsvps with user displays", async () => {
    await post(app, `/events/${eventId}/rsvps`, { status: "going" }, bobToken);
    const res = await get(app, `/events/${eventId}/rsvps?status=going`, aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rsvps: { profileId: string; profile: { displayName: string | null } | null }[];
    };
    expect(body.rsvps.length).toBe(1);
    expect(body.rsvps[0]!.profile?.displayName).toBe("Bob");
  });

  it("POST /events/:id/invite as organiser creates invited rows", async () => {
    const res = await post(
      app,
      `/events/${eventId}/invite`,
      { profileIds: ["usr_bob"] },
      aliceToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invited: number };
    expect(body.invited).toBe(1);
  });

  it("POST /events/:id/invite returns 403 for non-organiser", async () => {
    const res = await post(
      app,
      `/events/${eventId}/invite`,
      { profileIds: ["usr_carol"] },
      bobToken,
    );
    expect(res.status).toBe(403);
  });

  it("POST /events/:id/rsvps returns 403 on guest_list event without invite", async () => {
    const createRes = await post(
      app,
      "/events",
      { title: "Guest list", startTime: FUTURE, joinPolicy: "guest_list" },
      aliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await post(app, `/events/${event.id}/rsvps`, { status: "going" }, bobToken);
    expect(res.status).toBe(403);
  });
});

describe("ICS route", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let osn: ReturnType<typeof createOsnTestContext>;
  let app: ReturnType<typeof createEventsRoutes>;
  let aliceToken: string;

  beforeEach(async () => {
    layer = createTestLayer();
    osn = createOsnTestContext();
    app = createEventsRoutes(layer, TEST_JWT_SECRET, osn.layer);
    aliceToken = await makeToken("usr_alice");
  });

  it("GET /events/:id/ics returns text/calendar body", async () => {
    const createRes = await post(
      app,
      "/events",
      { title: "Concert", startTime: FUTURE },
      aliceToken,
    );
    const { event } = (await createRes.json()) as { event: { id: string } };
    const res = await get(app, `/events/${event.id}/ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("SUMMARY:Concert");
  });

  it("GET /events/:id/ics returns 404 for missing event", async () => {
    const res = await get(app, "/events/evt_missing/ics");
    expect(res.status).toBe(404);
  });
});

describe("Comms routes", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let osn: ReturnType<typeof createOsnTestContext>;
  let app: ReturnType<typeof createEventsRoutes>;
  let aliceToken: string;
  let bobToken: string;
  let eventId: string;

  beforeEach(async () => {
    layer = createTestLayer();
    osn = createOsnTestContext();
    app = createEventsRoutes(layer, TEST_JWT_SECRET, osn.layer);
    aliceToken = await makeToken("usr_alice");
    bobToken = await makeToken("usr_bob");
    const res = await post(
      app,
      "/events",
      { title: "Party", startTime: FUTURE, commsChannels: ["sms", "email"] },
      aliceToken,
    );
    eventId = ((await res.json()) as { event: { id: string } }).event.id;
  });

  it("GET /events/:id/comms returns configured channels + empty blasts", async () => {
    const res = await get(app, `/events/${eventId}/comms`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: string[]; blasts: unknown[] };
    expect(body.channels).toEqual(["sms", "email"]);
    expect(body.blasts).toEqual([]);
  });

  it("POST /events/:id/comms/blasts as organiser creates blasts and returns 201", async () => {
    const res = await post(
      app,
      `/events/${eventId}/comms/blasts`,
      { channels: ["email"], body: "Don't forget!" },
      aliceToken,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { blasts: { channel: string; body: string }[] };
    expect(body.blasts).toHaveLength(1);
    expect(body.blasts[0]!.channel).toBe("email");
    expect(body.blasts[0]!.body).toBe("Don't forget!");
  });

  it("POST /events/:id/comms/blasts returns 403 for non-organiser", async () => {
    const res = await post(
      app,
      `/events/${eventId}/comms/blasts`,
      { channels: ["email"], body: "Hi" },
      bobToken,
    );
    expect(res.status).toBe(403);
  });

  it("POST /events/:id/comms/blasts returns 401 when unauthenticated", async () => {
    const res = await post(app, `/events/${eventId}/comms/blasts`, {
      channels: ["email"],
      body: "Hi",
    });
    expect(res.status).toBe(401);
  });

  it("POST /events/:id/comms/blasts returns 422 for empty body", async () => {
    const res = await post(
      app,
      `/events/${eventId}/comms/blasts`,
      { channels: ["email"], body: "" },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Visibility gate (S-H1/H2/H3/H5) — every direct-fetch route hides
// private events from non-authorised callers. The discovery filter and
// the direct-fetch filter must agree at all times.
// ---------------------------------------------------------------------------

describe("Private event visibility gate", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let osn: ReturnType<typeof createOsnTestContext>;
  let app: ReturnType<typeof createEventsRoutes>;
  let aliceToken: string;
  let bobToken: string;
  let privateEventId: string;
  let publicEventId: string;

  beforeEach(async () => {
    layer = createTestLayer();
    osn = createOsnTestContext();
    app = createEventsRoutes(layer, TEST_JWT_SECRET, osn.layer);
    aliceToken = await makeToken("usr_alice");
    bobToken = await makeToken("usr_bob");
    await seedOsnUser(osn, { id: "usr_alice", handle: "alice", displayName: "Alice" });
    await seedOsnUser(osn, { id: "usr_bob", handle: "bob", displayName: "Bob" });

    const privateRes = await post(
      app,
      "/events",
      { title: "Hidden", startTime: FUTURE, visibility: "private" },
      aliceToken,
    );
    privateEventId = ((await privateRes.json()) as { event: { id: string } }).event.id;

    const publicRes = await post(
      app,
      "/events",
      { title: "Public", startTime: FUTURE, visibility: "public" },
      aliceToken,
    );
    publicEventId = ((await publicRes.json()) as { event: { id: string } }).event.id;
  });

  // S-H1
  it("GET /events/:id returns 404 for private events to non-organiser viewers", async () => {
    const res = await get(app, `/events/${privateEventId}`, bobToken);
    expect(res.status).toBe(404);
  });

  it("GET /events/:id returns 404 for private events when unauthenticated", async () => {
    const res = await get(app, `/events/${privateEventId}`);
    expect(res.status).toBe(404);
  });

  it("GET /events/:id returns 200 for private events to the organiser", async () => {
    const res = await get(app, `/events/${privateEventId}`, aliceToken);
    expect(res.status).toBe(200);
  });

  it("GET /events/:id returns 200 for private events to viewers with an RSVP row", async () => {
    // Alice invites Bob to the private event.
    await post(app, `/events/${privateEventId}/invite`, { profileIds: ["usr_bob"] }, aliceToken);
    const res = await get(app, `/events/${privateEventId}`, bobToken);
    expect(res.status).toBe(200);
  });

  it("GET /events/:id returns 200 for public events to anyone", async () => {
    const res = await get(app, `/events/${publicEventId}`);
    expect(res.status).toBe(200);
  });

  // S-H2
  it("GET /events/:id/ics returns 404 for private events to non-authorised callers", async () => {
    const res = await get(app, `/events/${privateEventId}/ics`);
    expect(res.status).toBe(404);
  });

  it("GET /events/:id/ics returns 200 for private events to the organiser", async () => {
    const res = await get(app, `/events/${privateEventId}/ics`, aliceToken);
    expect(res.status).toBe(200);
  });

  // S-H3
  it("GET /events/:id/comms returns 404 for private events to non-authorised callers", async () => {
    const res = await get(app, `/events/${privateEventId}/comms`);
    expect(res.status).toBe(404);
  });

  it("GET /events/:id/comms returns 200 for private events to the organiser", async () => {
    const res = await get(app, `/events/${privateEventId}/comms`, aliceToken);
    expect(res.status).toBe(200);
  });

  // S-H5
  it("GET /events/:id/rsvps/counts returns 404 for private events to non-authorised callers", async () => {
    const res = await get(app, `/events/${privateEventId}/rsvps/counts`);
    expect(res.status).toBe(404);
  });

  it("GET /events/:id/rsvps/counts returns 200 for private events to the organiser", async () => {
    const res = await get(app, `/events/${privateEventId}/rsvps/counts`, aliceToken);
    expect(res.status).toBe(200);
  });

  // RSVPs route gating
  it("GET /events/:id/rsvps returns 404 for private events to non-authorised callers", async () => {
    const res = await get(app, `/events/${privateEventId}/rsvps`);
    expect(res.status).toBe(404);
  });

  // S-H4: invited list is organiser-only even on visible events
  it("GET /events/:id/rsvps?status=invited returns empty for non-organisers", async () => {
    await post(app, `/events/${publicEventId}/invite`, { profileIds: ["usr_bob"] }, aliceToken);
    const res = await get(app, `/events/${publicEventId}/rsvps?status=invited`, bobToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rsvps: unknown[] };
    expect(body.rsvps).toEqual([]);
  });

  it("GET /events/:id/rsvps?status=invited returns the list for the organiser", async () => {
    await post(app, `/events/${publicEventId}/invite`, { profileIds: ["usr_bob"] }, aliceToken);
    const res = await get(app, `/events/${publicEventId}/rsvps?status=invited`, aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rsvps: { profileId: string }[] };
    expect(body.rsvps).toHaveLength(1);
    expect(body.rsvps[0]!.profileId).toBe("usr_bob");
  });

  // S-L3: invitedByProfileId is gated to organiser viewers
  it("GET /events/:id/rsvps hides invitedByProfileId from non-organiser viewers", async () => {
    await post(app, `/events/${publicEventId}/invite`, { profileIds: ["usr_bob"] }, aliceToken);
    // Bob accepts the invite — now appears as "going" for everyone.
    const upsertRes = await post(
      app,
      `/events/${publicEventId}/rsvps`,
      { status: "going" },
      bobToken,
    );
    expect(upsertRes.status).toBe(200);
    // Random viewer (no token) sees the row but invitedByProfileId is null.
    const res = await get(app, `/events/${publicEventId}/rsvps?status=going`);
    const body = (await res.json()) as { rsvps: { invitedByProfileId: string | null }[] };
    expect(body.rsvps[0]!.invitedByProfileId).toBeNull();
  });

  it("GET /events/:id/rsvps shows invitedByProfileId to the organiser viewer", async () => {
    await post(app, `/events/${publicEventId}/invite`, { profileIds: ["usr_bob"] }, aliceToken);
    await post(app, `/events/${publicEventId}/rsvps`, { status: "going" }, bobToken);
    const res = await get(app, `/events/${publicEventId}/rsvps?status=going`, aliceToken);
    const body = (await res.json()) as { rsvps: { invitedByProfileId: string | null }[] };
    expect(body.rsvps[0]!.invitedByProfileId).toBe("usr_alice");
  });

  // isCloseFriend stamp
  it("GET /events/:id/rsvps stamps isCloseFriend = false on rows by default", async () => {
    await post(app, `/events/${publicEventId}/rsvps`, { status: "going" }, bobToken);
    const res = await get(app, `/events/${publicEventId}/rsvps?status=going`, aliceToken);
    const body = (await res.json()) as { rsvps: { isCloseFriend: boolean }[] };
    expect(body.rsvps[0]!.isCloseFriend).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S-M3 — text field length caps
// ---------------------------------------------------------------------------

describe("Event text field length caps (S-M3)", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let osn: ReturnType<typeof createOsnTestContext>;
  let app: ReturnType<typeof createEventsRoutes>;
  let aliceToken: string;

  beforeEach(async () => {
    layer = createTestLayer();
    osn = createOsnTestContext();
    app = createEventsRoutes(layer, TEST_JWT_SECRET, osn.layer);
    aliceToken = await makeToken("usr_alice");
  });

  it("POST /events rejects title longer than 200 chars", async () => {
    const res = await post(
      app,
      "/events",
      { title: "x".repeat(201), startTime: FUTURE },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });

  it("POST /events rejects description longer than 5000 chars", async () => {
    const res = await post(
      app,
      "/events",
      { title: "Concert", startTime: FUTURE, description: "x".repeat(5001) },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });

  it("POST /events accepts a 200-char title (boundary)", async () => {
    const res = await post(
      app,
      "/events",
      { title: "x".repeat(200), startTime: FUTURE },
      aliceToken,
    );
    expect(res.status).toBe(201);
  });

  it("POST /events rejects venue longer than 500 chars", async () => {
    const res = await post(
      app,
      "/events",
      { title: "Concert", startTime: FUTURE, venue: "x".repeat(501) },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });
});

describe("PATCH /me/settings", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let settingsApp: ReturnType<typeof createSettingsRoutes>;
  let aliceToken: string;

  beforeEach(async () => {
    layer = createTestLayer();
    settingsApp = createSettingsRoutes(layer, TEST_JWT_SECRET);
    aliceToken = await makeToken("usr_alice");
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await patch(settingsApp, "/me/settings", {
      attendanceVisibility: "no_one",
    });
    expect(res.status).toBe(401);
  });

  it("updates attendance visibility for authenticated user", async () => {
    const res = await patch(
      settingsApp,
      "/me/settings",
      { attendanceVisibility: "no_one" },
      aliceToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { profileId: string; attendanceVisibility: string };
    };
    expect(body.settings.profileId).toBe("usr_alice");
    expect(body.settings.attendanceVisibility).toBe("no_one");
  });

  it("returns 422 for invalid enum value", async () => {
    const res = await patch(
      settingsApp,
      "/me/settings",
      { attendanceVisibility: "everyone" },
      aliceToken,
    );
    expect(res.status).toBe(422);
  });
});
