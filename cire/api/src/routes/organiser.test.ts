import { describe, it, expect, beforeAll } from "bun:test";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

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
// unauthenticated.
describe("GET /api/organiser/guests", () => {
  it("returns 401 without an OSN access token", async () => {
    const app = buildApp();
    const res = await app.request("/api/organiser/guests");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorised" });
  });

  it("returns the guest list with a valid OSN access token", async () => {
    const app = buildApp();
    const res = await app.request("/api/organiser/guests", {
      headers: { Authorization: `Bearer ${await auth.sign("usr_anyone")}` },
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

  it("returns the event list with a valid OSN access token", async () => {
    const app = buildApp();
    const res = await app.request("/api/organiser/events", {
      headers: { Authorization: `Bearer ${await auth.sign("usr_anyone")}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(rows).toHaveLength(5);
  });
});
