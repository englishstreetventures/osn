import { describe, it, expect, beforeAll } from "bun:test";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Seeded bootstrap wedding owner (see seedBootstrapWedding in db/setup.ts).
const OWNER = "usr_REPLACE_BEFORE_PROD";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  return createApp(db, { osnTestKey: auth.key });
}

// Locks in the Phase 5 security fix: these endpoints were previously
// unauthenticated, and are now both authenticated AND scoped to the
// caller's owned wedding (derived — flat alias routes carry no
// :weddingId; deleted entirely in Phase 6).
describe("GET /api/organiser/guests", () => {
  it("returns 401 without an OSN access token", async () => {
    const app = buildApp();
    const res = await app.request("/api/organiser/guests");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorised" });
  });

  it("returns 404 no_weddings for an authenticated non-owner", async () => {
    const app = buildApp();
    const res = await app.request("/api/organiser/guests", {
      headers: { Authorization: `Bearer ${await auth.sign("usr_anyone")}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_weddings" });
  });

  it("returns the guest list for the wedding owner", async () => {
    const app = buildApp();
    const res = await app.request("/api/organiser/guests", {
      headers: { Authorization: `Bearer ${await auth.sign(OWNER)}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(rows).toHaveLength(6);
  });
});

describe("GET /api/organiser/events", () => {
  it("returns 401 without an OSN access token", async () => {
    const app = buildApp();
    const res = await app.request("/api/organiser/events");
    expect(res.status).toBe(401);
  });

  it("returns 404 no_weddings for an authenticated non-owner", async () => {
    const app = buildApp();
    const res = await app.request("/api/organiser/events", {
      headers: { Authorization: `Bearer ${await auth.sign("usr_anyone")}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_weddings" });
  });

  it("returns the event list for the wedding owner", async () => {
    const app = buildApp();
    const res = await app.request("/api/organiser/events", {
      headers: { Authorization: `Bearer ${await auth.sign(OWNER)}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(rows).toHaveLength(5);
  });

  it("returns 400 multiple_weddings when the caller owns more than one", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const now = new Date();
    const schema = await import("@cire/db");
    db.insert(schema.weddings)
      .values({
        id: "wed_second",
        slug: "second",
        displayName: "Second Wedding",
        ownerOsnProfileId: OWNER,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const app = createApp(db, { osnTestKey: auth.key });
    const res = await app.request("/api/organiser/events", {
      headers: { Authorization: `Bearer ${await auth.sign(OWNER)}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("multiple_weddings");
  });
});
