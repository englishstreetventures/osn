import { describe, it, expect, beforeAll } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import type { AppOptions } from "../app";
import type { Db } from "../db";
import { createDb } from "../db/setup";
import type { OsnHandleResolver } from "../services/osn-bridge";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const WEDDING_ID = "wed_hosts";
const OWNER = "usr_owner";
const COHOST = "usr_bob"; // profile id the stub resolver returns for "bob"
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** Resolver stub: maps known handles to profile ids; everything else 404s. */
const HANDLE_TO_PROFILE: Record<string, string> = { bob: COHOST, carol: "usr_carol" };
const stubResolver: OsnHandleResolver = async (handle) => {
  const normalised = (handle.startsWith("@") ? handle.slice(1) : handle).trim().toLowerCase();
  const profileId = HANDLE_TO_PROFILE[normalised];
  return profileId
    ? { ok: true, profileId, handle: normalised }
    : { ok: false, reason: "profile_not_found" };
};

/** Resolver that always throws — stands in for osn-api returning a 5xx. */
const throwingResolver: OsnHandleResolver = async () => {
  throw new Error("osn-api 500");
};

function seedWedding(db: Db) {
  const now = new Date();
  db.insert(weddings)
    .values({
      id: WEDDING_ID,
      slug: "hosts-wedding",
      displayName: "Hosts Wedding",
      ownerOsnProfileId: OWNER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function buildApp(overrides: Partial<AppOptions> = {}) {
  const db = createDb(":memory:");
  seedWedding(db);
  const app = createApp(db, {
    osnTestKey: auth.key,
    resolveOsnProfileByHandle: stubResolver,
    ...overrides,
  });
  return { db, app };
}

async function req(
  app: ReturnType<typeof buildApp>["app"],
  method: string,
  path: string,
  profileId?: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return appRequest(app, path, init);
}

const hostsPath = `/api/organiser/weddings/${WEDDING_ID}/hosts`;

describe("POST /api/organiser/weddings/:weddingId/hosts (add by handle)", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", hostsPath, undefined, { handle: "bob" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-owner (stranger)", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", hostsPath, STRANGER, { handle: "bob" });
    expect(res.status).toBe(403);
  });

  it("returns 403 for a CO-HOST trying to add another host (owner-only)", async () => {
    const { db, app } = buildApp();
    // Make bob a co-host first.
    db.insert(weddingHosts)
      .values({
        id: "whost_bob",
        weddingId: WEDDING_ID,
        osnProfileId: COHOST,
        addedByOsnProfileId: OWNER,
        createdAt: new Date(),
      })
      .run();
    const res = await req(app, "POST", hostsPath, COHOST, { handle: "carol" });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", "/api/organiser/weddings/wed_nope/hosts", OWNER, {
      handle: "bob",
    });
    expect(res.status).toBe(404);
  });

  it("adds a host by handle for the owner and persists it", async () => {
    const { db, app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "@Bob" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { host: { osnProfileId: string; handle: string } };
    expect(body.host.osnProfileId).toBe(COHOST);
    expect(body.host.handle).toBe("bob");

    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.weddingId).toBe(WEDDING_ID);
    expect(row!.addedByOsnProfileId).toBe(OWNER);
  });

  it("returns 404 when the handle resolves to no OSN account", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "ghost" });
    expect(res.status).toBe(404);
  });

  it("returns 409 already_host when re-adding the same person", async () => {
    const { app } = buildApp();
    await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "already_host" });
  });

  it("returns 400 for a missing handle", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, {});
    expect(res.status).toBe(400);
  });

  it("returns 503 when the ARC bridge is unconfigured (fail closed)", async () => {
    const { app } = buildApp({ resolveOsnProfileByHandle: undefined });
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(res.status).toBe(503);
  });

  it("returns 502 when the resolver throws (osn unavailable)", async () => {
    const { app } = buildApp({ resolveOsnProfileByHandle: throwingResolver });
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(res.status).toBe(502);
  });

  it("429s once the per-IP host limit is exceeded (S-L1)", async () => {
    const { app } = buildApp({
      hostLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const first = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(first.status).toBe(201);
    const second = await req(app, "POST", hostsPath, OWNER, { handle: "carol" });
    expect(second.status).toBe(429);
  });
});

describe("GET /api/organiser/weddings/:weddingId/hosts (list)", () => {
  function seedCohost(db: Db) {
    db.insert(weddingHosts)
      .values({
        id: "whost_bob",
        weddingId: WEDDING_ID,
        osnProfileId: COHOST,
        addedByOsnProfileId: OWNER,
        createdAt: new Date(),
      })
      .run();
  }

  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", hostsPath);
    expect(res.status).toBe(401);
  });

  it("lists hosts for the owner", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: { osnProfileId: string }[] };
    expect(body.hosts.map((h) => h.osnProfileId)).toEqual([COHOST]);
  });

  it("lists hosts for a CO-HOST too (member read)", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, COHOST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: { osnProfileId: string }[] };
    expect(body.hosts.map((h) => h.osnProfileId)).toEqual([COHOST]);
  });

  it("returns 403 for a stranger", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, STRANGER);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/organiser/weddings/:weddingId/hosts/:osnProfileId (remove)", () => {
  function seedCohost(db: Db) {
    db.insert(weddingHosts)
      .values({
        id: "whost_bob",
        weddingId: WEDDING_ID,
        osnProfileId: COHOST,
        addedByOsnProfileId: OWNER,
        createdAt: new Date(),
      })
      .run();
  }

  it("returns 401 without a token", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-owner", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`, STRANGER);
    expect(res.status).toBe(403);
  });

  it("returns 403 when a co-host tries to remove a host (owner-only)", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`, COHOST);
    expect(res.status).toBe(403);
    // The row is untouched.
    expect(db.select().from(weddingHosts).all()).toHaveLength(1);
  });

  it("removes a host for the owner", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`, OWNER);
    expect(res.status).toBe(200);
    expect(db.select().from(weddingHosts).all()).toHaveLength(0);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await req(app, "DELETE", `/api/organiser/weddings/wed_nope/hosts/${COHOST}`, OWNER);
    expect(res.status).toBe(404);
  });
});

describe("co-host dashboard access (weddingMember)", () => {
  function seedCohostAndGuest(db: Db) {
    const now = new Date();
    db.insert(weddingHosts)
      .values({
        id: "whost_bob",
        weddingId: WEDDING_ID,
        osnProfileId: COHOST,
        addedByOsnProfileId: OWNER,
        createdAt: now,
      })
      .run();
  }

  it("lets a co-host read the wedding's guest dashboard", async () => {
    const { db, app } = buildApp();
    seedCohostAndGuest(db);
    const res = await req(app, "GET", `/api/organiser/weddings/${WEDDING_ID}/guests`, COHOST);
    expect(res.status).toBe(200);
  });

  it("still 403s a stranger on the guest dashboard", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", `/api/organiser/weddings/${WEDDING_ID}/guests`, STRANGER);
    expect(res.status).toBe(403);
  });

  it("lets a co-host read the wedding's events too (weddingMember, not just guests)", async () => {
    const { db, app } = buildApp();
    seedCohostAndGuest(db);
    const res = await req(app, "GET", `/api/organiser/weddings/${WEDDING_ID}/events`, COHOST);
    expect(res.status).toBe(200);
  });

  it("still 403s a stranger on the events dashboard", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", `/api/organiser/weddings/${WEDDING_ID}/events`, STRANGER);
    expect(res.status).toBe(403);
  });

  it("403s a co-host on the owner-only regenerate-code action", async () => {
    const { db, app } = buildApp();
    seedCohostAndGuest(db);
    const res = await req(
      app,
      "POST",
      `/api/organiser/weddings/${WEDDING_ID}/families/fam_x/regenerate-code`,
      COHOST,
    );
    expect(res.status).toBe(403);
  });

  it("includes a co-hosted wedding in the member's wedding list", async () => {
    const { db, app } = buildApp();
    seedCohostAndGuest(db);
    const res = await req(app, "GET", "/api/organiser/weddings", COHOST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weddings: { id: string; role: string }[] };
    expect(body.weddings).toEqual([
      { id: WEDDING_ID, slug: "hosts-wedding", displayName: "Hosts Wedding", role: "host" },
    ]);
  });
});
