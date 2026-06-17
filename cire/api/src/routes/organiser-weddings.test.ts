import { describe, it, expect, beforeAll } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guests, sessions, weddings } from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Owner of the seeded bootstrap wedding (see seedBootstrapWedding).
const BOOTSTRAP_OWNER = "usr_REPLACE_BEFORE_PROD";
const OTHER_WEDDING_ID = "wed_other";
const OTHER_OWNER = "usr_bob";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** Seeds the bootstrap wedding + a second wedding owned by someone else. */
function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  seedOtherWedding(db);
  const app = createApp(db, { osnTestKey: auth.key });
  return { db, app };
}

function seedOtherWedding(db: Db) {
  const now = new Date();
  db.insert(weddings)
    .values({
      id: OTHER_WEDDING_ID,
      slug: "other-wedding",
      displayName: "Other Wedding",
      ownerOsnProfileId: OTHER_OWNER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(events)
    .values({
      id: "evt_other",
      weddingId: OTHER_WEDDING_ID,
      slug: "other-party",
      name: "Other Party",
      date: "2027-01-01",
      location: "Elsewhere",
      description: "",
      startAt: "2027-01-01T16:00:00+10:00",
      endAt: "2027-01-01T22:00:00+10:00",
      timezone: "Australia/Sydney",
      sortOrder: 0,
    })
    .run();
  db.insert(families)
    .values({
      id: "fam_other",
      weddingId: OTHER_WEDDING_ID,
      publicId: "OTHER-ZZZ-0000",
      familyName: "Other",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(guests)
    .values({
      id: "gst_other",
      familyId: "fam_other",
      firstName: "Olive",
      lastName: "Other",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

async function get(app: ReturnType<typeof buildApp>["app"], path: string, profileId?: string) {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { headers });
}

describe("GET /api/organiser/weddings", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await get(app, "/api/organiser/weddings");
    expect(res.status).toBe(401);
  });

  it("lists only the caller's weddings", async () => {
    const { app } = buildApp();
    const res = await get(app, "/api/organiser/weddings", BOOTSTRAP_OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weddings: { id: string }[] };
    expect(body.weddings.map((w) => w.id)).toEqual([BOOTSTRAP_WEDDING_ID]);
  });

  it("returns an empty list for a profile owning nothing", async () => {
    const { app } = buildApp();
    const res = await get(app, "/api/organiser/weddings", "usr_nobody");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weddings: unknown[] };
    expect(body.weddings).toEqual([]);
  });
});

describe("GET /api/organiser/weddings/:weddingId/guests", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await get(app, `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests`);
    expect(res.status).toBe(401);
  });

  it("returns the guest list scoped to the wedding for its owner", async () => {
    const { app } = buildApp();
    const res = await get(
      app,
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests`,
      BOOTSTRAP_OWNER,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { firstName: string }[];
    // Seed data has 6 guests in the bootstrap wedding; the other wedding's
    // guest must NOT leak in.
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.firstName === "Olive")).toBeUndefined();
  });

  it("scopes to the other wedding for its owner", async () => {
    const { app } = buildApp();
    const res = await get(app, `/api/organiser/weddings/${OTHER_WEDDING_ID}/guests`, OTHER_OWNER);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { firstName: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstName).toBe("Olive");
  });

  it("returns 403 for a non-owner", async () => {
    const { app } = buildApp();
    const res = await get(
      app,
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests`,
      OTHER_OWNER,
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await get(app, "/api/organiser/weddings/wed_nope/guests", BOOTSTRAP_OWNER);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/organiser/weddings/:weddingId/events", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await get(app, `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events`);
    expect(res.status).toBe(401);
  });

  it("returns events scoped to the wedding for its owner", async () => {
    const { app } = buildApp();
    const res = await get(app, `/api/organiser/weddings/${OTHER_WEDDING_ID}/events`, OTHER_OWNER);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["evt_other"]);
  });

  it("returns 403 for a non-owner", async () => {
    const { app } = buildApp();
    const res = await get(app, `/api/organiser/weddings/${OTHER_WEDDING_ID}/events`, "usr_nobody");
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await get(app, "/api/organiser/weddings/wed_nope/events", BOOTSTRAP_OWNER);
    expect(res.status).toBe(404);
  });
});

async function post(app: ReturnType<typeof buildApp>["app"], path: string, profileId?: string) {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { method: "POST", headers });
}

describe("POST /api/organiser/weddings/:weddingId/families/:familyId/regenerate-code (C2)", () => {
  async function postRegen(
    app: ReturnType<typeof buildApp>["app"],
    weddingId: string,
    familyId: string,
    profileId?: string,
  ) {
    const headers: Record<string, string> = {};
    if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
    return appRequest(
      app,
      `/api/organiser/weddings/${weddingId}/families/${familyId}/regenerate-code`,
      {
        method: "POST",
        headers,
      },
    );
  }

  /** A real family id in the bootstrap wedding (seed mints random UUIDs). */
  function aBootstrapFamily(db: Db): { id: string; publicId: string } {
    const row = db
      .select({ id: families.id, publicId: families.publicId })
      .from(families)
      .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
      .all()[0];
    if (!row) throw new Error("no bootstrap family seeded");
    return row;
  }

  it("returns 401 without a token", async () => {
    const { db, app } = buildApp();
    const fam = aBootstrapFamily(db);
    const res = await postRegen(app, BOOTSTRAP_WEDDING_ID, fam.id);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-owner", async () => {
    const { db, app } = buildApp();
    const fam = aBootstrapFamily(db);
    const res = await postRegen(app, BOOTSTRAP_WEDDING_ID, fam.id, OTHER_OWNER);
    expect(res.status).toBe(403);
  });

  it("rotates the code (old code replaced) for the wedding owner", async () => {
    const { db, app } = buildApp();
    const fam = aBootstrapFamily(db);
    const res = await postRegen(app, BOOTSTRAP_WEDDING_ID, fam.id, BOOTSTRAP_OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { familyId: string; publicId: string };
    expect(body.familyId).toBe(fam.id);
    expect(body.publicId).not.toBe(fam.publicId);
    // The new code is persisted; the old one no longer resolves.
    const stored = db
      .select({ publicId: families.publicId })
      .from(families)
      .where(eq(families.id, fam.id))
      .all()[0];
    expect(stored!.publicId).toBe(body.publicId);
    // New code is in the tiered format (bootstrap defaults to `secure` → 4 segs).
    expect(body.publicId.split("-")).toHaveLength(4);
  });

  it("revokes all of the family's sessions atomically", async () => {
    const { db, app } = buildApp();
    const fam = aBootstrapFamily(db);
    // Plant two live sessions for the family.
    const now = new Date();
    const future = new Date(now.getTime() + 60_000);
    db.insert(sessions)
      .values({ id: "s1", familyId: fam.id, token: "h1", expiresAt: future, createdAt: now })
      .run();
    db.insert(sessions)
      .values({ id: "s2", familyId: fam.id, token: "h2", expiresAt: future, createdAt: now })
      .run();
    expect(db.select().from(sessions).where(eq(sessions.familyId, fam.id)).all()).toHaveLength(2);

    const res = await postRegen(app, BOOTSTRAP_WEDDING_ID, fam.id, BOOTSTRAP_OWNER);
    expect(res.status).toBe(200);
    // All sessions for the family are gone.
    expect(db.select().from(sessions).where(eq(sessions.familyId, fam.id)).all()).toHaveLength(0);
  });

  it("returns 404 when the family does not belong to the wedding (cross-tenant guard)", async () => {
    const { app } = buildApp();
    // fam_other lives under OTHER_WEDDING_ID — the bootstrap owner can't rotate it
    // through their own wedding's route.
    const res = await postRegen(app, BOOTSTRAP_WEDDING_ID, "fam_other", BOOTSTRAP_OWNER);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/organiser/weddings/:weddingId/preview-code", () => {
  const path = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/preview-code`;

  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await post(app, path);
    expect(res.status).toBe(401);
  });

  it("mints a HOST-* preview code for the owner", async () => {
    const { app } = buildApp();
    const res = await post(app, path, BOOTSTRAP_OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicId: string };
    expect(body.publicId).toMatch(/^HOST-[A-F0-9]{32}$/);
  });

  it("is idempotent — the same owner gets the same code", async () => {
    const { app } = buildApp();
    const first = (await (await post(app, path, BOOTSTRAP_OWNER)).json()) as { publicId: string };
    const second = (await (await post(app, path, BOOTSTRAP_OWNER)).json()) as { publicId: string };
    expect(second.publicId).toBe(first.publicId);
  });

  it("returns 403 for a non-owner", async () => {
    const { app } = buildApp();
    const res = await post(app, path, OTHER_OWNER);
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await post(app, "/api/organiser/weddings/wed_nope/preview-code", BOOTSTRAP_OWNER);
    expect(res.status).toBe(404);
  });

  it("does not leak the host preview family into the organiser guest roster", async () => {
    const { app } = buildApp();
    // Provision the host preview family/guest.
    const minted = await post(app, path, BOOTSTRAP_OWNER);
    expect(minted.status).toBe(200);

    const res = await get(
      app,
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests`,
      BOOTSTRAP_OWNER,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { firstName: string; publicId: string }[];
    // Still the 6 real guests — the synthetic "Wedding Host" must not appear.
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.firstName === "Wedding")).toBeUndefined();
    expect(rows.find((r) => r.publicId.startsWith("HOST-"))).toBeUndefined();
  });
});
