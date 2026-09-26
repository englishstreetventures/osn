import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, guests, weddingHosts, weddings } from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { appRequest, jsonBody } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { guestNamed, seedPlusOne } from "../test-helpers/plus-one";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  for (const [osnProfileId, role] of [
    [EDITOR, "editor"],
    [VIEWER, "viewer"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id: `whost_${role}`,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId,
        addedByOsnProfileId: OWNER,
        role,
        createdAt: now,
      })
      .run();
  }
  // A second wedding the stranger owns, for the cross-wedding cases.
  db.insert(weddings)
    .values({
      id: "wed_other",
      slug: "other-wedding",
      displayName: "Other Wedding",
      ownerOsnProfileId: STRANGER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const app = createApp(db, { osnTestKey: auth.key });
  return { db, app };
}

type App = ReturnType<typeof buildApp>["app"];

async function put(app: App, path: string, profileId: string | undefined, body: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { method: "PUT", headers, body: JSON.stringify(body) });
}

const guestPath = (guestId: string, weddingId = BOOTSTRAP_WEDDING_ID) =>
  `/api/organiser/weddings/${weddingId}/guests/${guestId}/plus-one`;
const familyPath = (familyId: string, weddingId = BOOTSTRAP_WEDDING_ID) =>
  `/api/organiser/weddings/${weddingId}/families/${familyId}/plus-one`;

describe("PUT …/guests/:guestId/plus-one", () => {
  it("401s without a token", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    expect((await put(app, guestPath(bo.id), undefined, { allowed: true })).status).toBe(401);
  });

  it("403s read_only_role for a viewer, and a stranger", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    const viewer = await put(app, guestPath(bo.id), VIEWER, { allowed: true });
    expect(viewer.status).toBe(403);
    expect(await jsonBody(viewer)).toMatchObject({ error: "read_only_role" });
    expect((await put(app, guestPath(bo.id), STRANGER, { allowed: true })).status).toBe(403);
  });

  it("lets an editor set the permission", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    const res = await put(app, guestPath(bo.id), EDITOR, { allowed: true });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      guestId: bo.id,
      plusOneAllowed: true,
      plusOneRemoved: false,
    });
    const row = db
      .select({ allowed: guests.plusOneAllowed })
      .from(guests)
      .where(eq(guests.id, bo.id))
      .get();
    expect(row?.allowed).toBe(true);
  });

  it("400s a body without `allowed`", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    expect((await put(app, guestPath(bo.id), OWNER, {})).status).toBe(400);
  });

  it("409s plus_one_named, then removes the plus-one only when asked", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });

    const refused = await put(app, guestPath(bo.id), OWNER, { allowed: false });
    expect(refused.status).toBe(409);
    expect(await jsonBody(refused)).toEqual({ error: "plus_one_named", named: 1 });
    expect(db.select().from(guests).where(eq(guests.id, samId)).all()).toHaveLength(1);

    const removed = await put(app, guestPath(bo.id), OWNER, {
      allowed: false,
      removePlusOne: true,
    });
    expect(removed.status).toBe(200);
    expect(await jsonBody(removed)).toMatchObject({ plusOneRemoved: true });
    expect(db.select().from(guests).where(eq(guests.id, samId)).all()).toHaveLength(0);
  });

  it("409s plus_one_cannot_invite on a plus-one's own row", async () => {
    const { db, app } = buildApp();
    const samId = seedPlusOne(db, guestNamed(db, "Bo").id, { firstName: "Sam" });
    const res = await put(app, guestPath(samId), OWNER, { allowed: true });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "plus_one_cannot_invite" });
  });

  it("404s a guest of another wedding, even for that wedding's owner", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    const res = await put(app, guestPath(bo.id, "wed_other"), STRANGER, { allowed: true });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "guest_not_found" });
  });
});

describe("PUT …/families/:familyId/plus-one", () => {
  it("sets every member's permission", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    const res = await put(app, familyPath(bo.familyId), EDITOR, { allowed: true });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      familyId: bo.familyId,
      plusOneAllowed: true,
      guestsUpdated: 3,
      plusOnesRemoved: 0,
    });
  });

  it("403s read_only_role for a viewer", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    expect((await put(app, familyPath(bo.familyId), VIEWER, { allowed: true })).status).toBe(403);
  });

  it("409s plus_one_named with the count, then removes them when asked", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    seedPlusOne(db, guestNamed(db, "Dot").id, { firstName: "Pat" });

    const refused = await put(app, familyPath(bo.familyId), OWNER, { allowed: false });
    expect(refused.status).toBe(409);
    expect(await jsonBody(refused)).toEqual({ error: "plus_one_named", named: 2 });

    const removed = await put(app, familyPath(bo.familyId), OWNER, {
      allowed: false,
      removePlusOnes: true,
    });
    expect(await jsonBody(removed)).toMatchObject({ plusOnesRemoved: 2, guestsUpdated: 3 });
  });

  it("404s a household of another wedding", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    const res = await put(app, familyPath(bo.familyId, "wed_other"), STRANGER, {
      allowed: true,
    });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "family_not_found" });
  });
});
