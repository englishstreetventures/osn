import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, weddingHosts, weddings } from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
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

function buildApp() {
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
  const app = createApp(db, { osnTestKey: auth.key });
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
    const body = (await res.json()) as { wedding: Record<string, unknown> };
    expect(body.wedding).toEqual({
      id: BOOTSTRAP_WEDDING_ID,
      slug: "cire-wedding",
      displayName: "Cire Wedding",
      weddingDate: null,
      guestCountEstimate: null,
      currency: "AUD",
      budgetTotalMinor: null,
    });
  });

  it("admits a VIEWER co-host on the settings read (member-level)", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", SETTINGS_PATH, VIEWER);
    expect(res.status).toBe(200);
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

describe("event location config is gone (dropped by migration 0036)", () => {
  const EVENTS_PATH = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events`;
  const POINT = { locationLat: -33.8688, locationLng: 151.2093, pricingRegion: "au-nsw" };

  it("404s the removed per-event location write route", async () => {
    const { app, db } = buildApp();
    const res = await req(app, "PUT", `${EVENTS_PATH}/${firstEventId(db)}/location`, OWNER, POINT);
    // No such route now — Elysia has no handler for the path, so a 404 (not a
    // 200/400/403 from a live handler) proves the surface is gone.
    expect(res.status).toBe(404);
  });

  it("404s the removed settings/geocode route", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", `${SETTINGS_PATH}/geocode`, OWNER, { query: "Sydney" });
    expect(res.status).toBe(404);
  });

  it("the organiser events read carries no location fields", async () => {
    // The payload the portal seeds its event list from must not expose the
    // retired planning columns — an event's place is its free-text `address`.
    const { app } = buildApp();
    const res = await req(app, "GET", EVENTS_PATH, OWNER);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("locationLat");
      expect(row).not.toHaveProperty("locationLng");
      expect(row).not.toHaveProperty("pricingRegion");
      // The real location source is still there.
      expect(row).toHaveProperty("address");
    }
  });
});

function getWedding(db: Db) {
  const row = db.select().from(weddings).where(eq(weddings.id, BOOTSTRAP_WEDDING_ID)).get();
  if (!row) throw new Error("bootstrap wedding missing");
  return row;
}
