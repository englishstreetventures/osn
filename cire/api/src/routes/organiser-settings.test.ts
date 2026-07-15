import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, weddingHosts, weddings } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import type { Geocoder } from "../services/geocode";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const OWNER = "usr_dev_bootstrap_owner";
const CO_HOST = "usr_cohost";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";
const OTHER_EVENT_ID = "evt_other";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

const stubGeocoder: Geocoder = {
  async geocode(query: string) {
    if (query === "nowhere") return { status: "not_found" };
    if (query === "down") return { status: "unavailable" };
    return {
      status: "ok",
      point: {
        lat: -33.8688,
        lng: 151.2093,
        locality: "Sydney",
        adminArea: "NSW",
        countryCode: "AU",
        formattedAddress: "Sydney NSW, Australia",
      },
    };
  },
};

function buildApp(options: { geocoder?: Geocoder | null } = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts)
    .values({
      id: "whost_1",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: CO_HOST,
      addedByOsnProfileId: OWNER,
      // Legacy pre-0031 value — normalised to editor by the gates.
      role: "host",
      createdAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values({
      id: "whost_viewer",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: VIEWER,
      addedByOsnProfileId: OWNER,
      role: "viewer",
      createdAt: now,
    })
    .run();
  db.insert(weddings)
    .values({
      id: "wed_other",
      slug: "other-wedding",
      displayName: "Other Wedding",
      ownerOsnProfileId: "usr_bob",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(events)
    .values({
      id: OTHER_EVENT_ID,
      weddingId: "wed_other",
      slug: "other-party",
      name: "Other Party",
      description: "",
      startAt: "2027-01-01T16:00:00+10:00",
      endAt: "2027-01-01T22:00:00+10:00",
      timezone: "Australia/Sydney",
      sortOrder: 0,
    })
    .run();
  const app = createApp(db, { osnTestKey: auth.key, geocoder: options.geocoder });
  return { db, app };
}

type App = ReturnType<typeof buildApp>["app"];

async function req(
  app: App,
  method: string,
  path: string,
  profileId?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return appRequest(app, path, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const SETTINGS_PATH = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/settings`;

/** First seeded event of the bootstrap wedding — the target for location tests. */
function firstEventId(db: Db): string {
  const row = db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
    .get();
  if (!row) throw new Error("no seeded event");
  return row.id;
}

describe("GET /api/organiser/weddings/:weddingId/settings", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    expect((await req(app, "GET", SETTINGS_PATH)).status).toBe(401);
  });

  it("returns 403 for a non-member", async () => {
    const { app } = buildApp();
    expect((await req(app, "GET", SETTINGS_PATH, STRANGER)).status).toBe(403);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", "/api/organiser/weddings/wed_missing/settings", OWNER);
    expect(res.status).toBe(404);
  });

  it("returns the profile with defaults for the owner", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", SETTINGS_PATH, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wedding: Record<string, unknown>;
      geocodingAvailable: boolean;
    };
    expect(body.wedding).toEqual({
      id: BOOTSTRAP_WEDDING_ID,
      slug: "cire-wedding",
      displayName: "Cire Wedding",
      weddingDate: null,
      guestCountEstimate: null,
      currency: "AUD",
      budgetTotalMinor: null,
    });
    expect(body.geocodingAvailable).toBe(false);
  });

  it("admits a VIEWER co-host on the settings read (member-level)", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", SETTINGS_PATH, VIEWER);
    expect(res.status).toBe(200);
  });

  it("admits a co-host and reports geocoding availability", async () => {
    const { app } = buildApp({ geocoder: stubGeocoder });
    const res = await req(app, "GET", SETTINGS_PATH, CO_HOST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { geocodingAvailable: boolean };
    expect(body.geocodingAvailable).toBe(true);
  });
});

describe("PUT /api/organiser/weddings/:weddingId/settings", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    expect((await req(app, "PUT", SETTINGS_PATH, undefined, {})).status).toBe(401);
  });

  it("returns 403 for a co-host (settings are owner-only)", async () => {
    const { app } = buildApp();
    expect((await req(app, "PUT", SETTINGS_PATH, CO_HOST, {})).status).toBe(403);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await req(app, "PUT", "/api/organiser/weddings/wed_missing/settings", OWNER, {});
    expect(res.status).toBe(404);
  });

  it("saves a full profile and persists it", async () => {
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
      displayName: "  Aisha & Ben  ",
      weddingDate: "2027-03-20",
      guestCountEstimate: 120,
      currency: "AUD",
      budgetTotalMinor: 4_500_000,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wedding: { displayName: string; weddingDate: string } };
    expect(body.wedding.displayName).toBe("Aisha & Ben");
    expect(body.wedding.weddingDate).toBe("2027-03-20");

    const row = getWedding(db);
    expect(row.weddingDate).toBe("2027-03-20");
    expect(row.guestCountEstimate).toBe(120);
    expect(row.budgetTotalMinor).toBe(4_500_000);
  });

  it("patches only the provided fields", async () => {
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, { weddingDate: "2027-03-20" });
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, { guestCountEstimate: 80 });
    expect(res.status).toBe(200);
    const row = getWedding(db);
    expect(row.weddingDate).toBe("2027-03-20");
    expect(row.guestCountEstimate).toBe(80);
    expect(row.displayName).toBe("Cire Wedding");
  });

  it("clears a nullable field with an explicit null", async () => {
    const { app, db } = buildApp();
    await req(app, "PUT", SETTINGS_PATH, OWNER, { weddingDate: "2027-03-20" });
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, { weddingDate: null });
    expect(res.status).toBe(200);
    expect(getWedding(db).weddingDate).toBeNull();
  });

  it("never writes the slug — a slug in the body is ignored (S-M1)", async () => {
    // Renaming would free the old slug for another organiser to claim while
    // printed invite links still point at it; the schema strips the field, so
    // even a hand-crafted body can't move it.
    const { app, db } = buildApp();
    const res = await req(app, "PUT", SETTINGS_PATH, OWNER, {
      slug: "squatted-slug",
      displayName: "Renamed",
    });
    expect(res.status).toBe(200);
    const row = getWedding(db);
    expect(row.slug).toBe("cire-wedding");
    expect(row.displayName).toBe("Renamed");
  });

  it("400s malformed JSON, bad shapes, and impossible dates", async () => {
    const { app } = buildApp();
    const rawRes = await appRequest(app, SETTINGS_PATH, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await auth.sign(OWNER)}`,
        "Content-Type": "application/json",
      },
      body: "{not json",
    });
    expect(rawRes.status).toBe(400);

    for (const bad of [
      { weddingDate: "20-03-2027" },
      { weddingDate: "2027-02-31" },
      { currency: "dollars" },
      { guestCountEstimate: 2.5 },
      { budgetTotalMinor: -1 },
      { displayName: "   " },
    ]) {
      const res = await req(app, "PUT", SETTINGS_PATH, OWNER, bad);
      expect(res.status).toBe(400);
    }
  });
});

describe("PUT /api/organiser/weddings/:weddingId/events/:eventId/location", () => {
  const locationPath = (eventId: string) =>
    `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events/${eventId}/location`;
  const POINT = { locationLat: -33.8688, locationLng: 151.2093, pricingRegion: "au-nsw" };

  it("returns 401 without a token", async () => {
    const { app, db } = buildApp();
    expect((await req(app, "PUT", locationPath(firstEventId(db)), undefined, POINT)).status).toBe(
      401,
    );
  });

  it("returns 403 for a non-member", async () => {
    const { app, db } = buildApp();
    expect((await req(app, "PUT", locationPath(firstEventId(db)), STRANGER, POINT)).status).toBe(
      403,
    );
  });

  it("returns 404 for an unknown event", async () => {
    const { app } = buildApp();
    const res = await req(app, "PUT", locationPath("evt_missing"), OWNER, POINT);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("event_not_found");
  });

  it("returns 404 for another wedding's event (tenant scoping)", async () => {
    const { app, db } = buildApp();
    const res = await req(app, "PUT", locationPath(OTHER_EVENT_ID), OWNER, POINT);
    expect(res.status).toBe(404);
    // The cross-tenant event is untouched.
    const other = db.select().from(events).where(eq(events.id, OTHER_EVENT_ID)).get();
    expect(other?.locationLat).toBeNull();
  });

  it("403s a VIEWER co-host with read_only_role (location is an editor write)", async () => {
    const { app, db } = buildApp();
    const eventId = firstEventId(db);
    const res = await req(app, "PUT", locationPath(eventId), VIEWER, POINT);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "read_only_role" });
    const row = db.select().from(events).where(eq(events.id, eventId)).get();
    expect(row?.locationLat).toBeNull();
  });

  it("saves a location as an EDITOR (schedule-level write, like the import)", async () => {
    const { app, db } = buildApp();
    const eventId = firstEventId(db);
    const res = await req(app, "PUT", locationPath(eventId), CO_HOST, POINT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event: { eventId, ...POINT } });

    const row = db.select().from(events).where(eq(events.id, eventId)).get();
    expect(row?.locationLat).toBe(-33.8688);
    expect(row?.locationLng).toBe(151.2093);
    expect(row?.pricingRegion).toBe("au-nsw");

    // Round-trip through the organiser events read — the contract the
    // portal's EventLocationsPanel seeds its form from. Dropping the columns
    // from listEvents would pass every other test while blanking the UI.
    const list = await req(
      app,
      "GET",
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events`,
      CO_HOST,
    );
    expect(list.status).toBe(200);
    const rows = (await list.json()) as {
      id: string;
      locationLat: number | null;
      locationLng: number | null;
      pricingRegion: string | null;
    }[];
    const saved = rows.find((r) => r.id === eventId);
    expect(saved).toMatchObject(POINT);
    const untouched = rows.find((r) => r.id !== eventId);
    expect(untouched?.locationLat).toBeNull();
    expect(untouched?.pricingRegion).toBeNull();
  });

  it("clears a location with the null trio", async () => {
    const { app, db } = buildApp();
    const eventId = firstEventId(db);
    await req(app, "PUT", locationPath(eventId), OWNER, POINT);
    const res = await req(app, "PUT", locationPath(eventId), OWNER, {
      locationLat: null,
      locationLng: null,
      pricingRegion: null,
    });
    expect(res.status).toBe(200);
    const row = db.select().from(events).where(eq(events.id, eventId)).get();
    expect(row?.locationLat).toBeNull();
    expect(row?.pricingRegion).toBeNull();
  });

  it("400s a half coordinate, bad ranges, and unknown regions", async () => {
    const { app, db } = buildApp();
    const eventId = firstEventId(db);
    for (const bad of [
      { locationLat: -33.8, locationLng: null, pricingRegion: null },
      { locationLat: null, locationLng: 151.2, pricingRegion: null },
      { locationLat: 123, locationLng: 151.2, pricingRegion: null },
      { locationLat: -33.8, locationLng: 999, pricingRegion: null },
      { locationLat: -33.8, locationLng: 151.2, pricingRegion: "au-sydney" },
      {},
    ]) {
      const res = await req(app, "PUT", locationPath(eventId), OWNER, bad);
      expect(res.status).toBe(400);
    }
  });

  it("allows a region without a point (address known, coordinates not)", async () => {
    const { app, db } = buildApp();
    const eventId = firstEventId(db);
    const res = await req(app, "PUT", locationPath(eventId), OWNER, {
      locationLat: null,
      locationLng: null,
      pricingRegion: "international",
    });
    expect(res.status).toBe(200);
    const row = db.select().from(events).where(eq(events.id, eventId)).get();
    expect(row?.pricingRegion).toBe("international");
    expect(row?.locationLat).toBeNull();
  });
});

describe("POST /api/organiser/weddings/:weddingId/settings/geocode", () => {
  const GEOCODE_PATH = `${SETTINGS_PATH}/geocode`;

  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    expect((await req(app, "POST", GEOCODE_PATH, undefined, { query: "Sydney" })).status).toBe(401);
  });

  it("returns 403 for a non-member", async () => {
    const { app } = buildApp({ geocoder: stubGeocoder });
    expect((await req(app, "POST", GEOCODE_PATH, STRANGER, { query: "Sydney" })).status).toBe(403);
  });

  it("403s a VIEWER co-host with read_only_role (billed upstream is editor-gated)", async () => {
    const { app } = buildApp({ geocoder: stubGeocoder });
    const res = await req(app, "POST", GEOCODE_PATH, VIEWER, { query: "Sydney NSW" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "read_only_role" });
  });

  it("admits a co-host (geocode serves the editor-writable event locations)", async () => {
    const { app } = buildApp({ geocoder: stubGeocoder });
    const res = await req(app, "POST", GEOCODE_PATH, CO_HOST, { query: "Sydney NSW" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("answers unavailable when no geocoder is configured (key-optional)", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", GEOCODE_PATH, OWNER, { query: "Sydney" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unavailable" });
  });

  it("returns the point + derived pricing region on a hit", async () => {
    const { app } = buildApp({ geocoder: stubGeocoder });
    const res = await req(app, "POST", GEOCODE_PATH, OWNER, { query: "Sydney NSW" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; pricingRegion: string };
    expect(body.status).toBe("ok");
    expect(body.pricingRegion).toBe("au-nsw");
  });

  it("passes through not_found and unavailable", async () => {
    const { app } = buildApp({ geocoder: stubGeocoder });
    expect(
      await (await req(app, "POST", GEOCODE_PATH, OWNER, { query: "nowhere" })).json(),
    ).toEqual({ status: "not_found" });
    expect(await (await req(app, "POST", GEOCODE_PATH, OWNER, { query: "down" })).json()).toEqual({
      status: "unavailable",
    });
  });

  it("400s an empty query", async () => {
    const { app } = buildApp({ geocoder: stubGeocoder });
    expect((await req(app, "POST", GEOCODE_PATH, OWNER, { query: "   " })).status).toBe(400);
  });

  it("429s once the per-IP limit is exhausted (the spend cap on the billed upstream)", async () => {
    // The limiter is the only in-code bound on per-request-billed Google
    // calls — this pins that the middleware is actually wired to THIS route.
    const db = createDb(":memory:");
    seedDb(db);
    const app = createApp(db, {
      osnTestKey: auth.key,
      geocoder: stubGeocoder,
      geocodeLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const first = await req(app, "POST", GEOCODE_PATH, OWNER, { query: "Sydney" });
    expect(first.status).toBe(200);
    const second = await req(app, "POST", GEOCODE_PATH, OWNER, { query: "Sydney" });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
  });
});

function getWedding(db: Db) {
  const row = db.select().from(weddings).where(eq(weddings.id, BOOTSTRAP_WEDDING_ID)).get();
  if (!row) throw new Error("bootstrap wedding missing");
  return row;
}
