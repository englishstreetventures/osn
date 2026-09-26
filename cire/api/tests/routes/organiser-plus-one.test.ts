import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, guests, weddingHosts, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { hostCodeService } from "../../src/services/host-code";
import { appRequest, jsonBody } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
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

/** A request carrying the given raw headers and no bearer token of ours. */
function putWith(app: App, path: string, headers: Record<string, string>, body: unknown) {
  return appRequest(app, path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const allowedOf = (db: TestDb, guestId: string) =>
  db.select({ a: guests.plusOneAllowed }).from(guests).where(eq(guests.id, guestId)).get()?.a;

/** The host-preview household and its one guest, created the way the portal does. */
async function hostHousehold(db: TestDb): Promise<{ familyId: string; guestId: string }> {
  await Effect.runPromise(
    hostCodeService
      .ensureForWedding(BOOTSTRAP_WEDDING_ID, "cire-wedding")
      .pipe(Effect.provideService(DbService, db)),
  );
  const [row] = db
    .select({ familyId: families.id, guestId: guests.id })
    .from(guests)
    .innerJoin(families, eq(guests.familyId, families.id))
    .where(eq(families.kind, "host"))
    .all();
  if (!row) throw new Error("no host household");
  return row;
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

describe("the organiser plus-one routes — credentials", () => {
  for (const [name, path] of [
    ["guest", (db: TestDb) => guestPath(guestNamed(db, "Bo").id)],
    ["household", (db: TestDb) => familyPath(guestNamed(db, "Bo").familyId)],
  ] as const) {
    it(`${name}: an editor's session cookie is accepted`, async () => {
      const { db, app } = buildApp();
      const token = await seedOrganiserSession(db, EDITOR);
      const res = await putWith(
        app,
        path(db),
        { cookie: `cire_org_session=${token}` },
        {
          allowed: true,
        },
      );
      expect(res.status).toBe(200);
      expect(allowedOf(db, guestNamed(db, "Bo").id)).toBe(true);
    });

    it(`${name}: refuses no credential, a dead cookie, a malformed bearer and a stranger`, async () => {
      const { db, app } = buildApp();
      const target = path(db);
      expect((await putWith(app, target, {}, { allowed: true })).status).toBe(401);
      expect(
        (
          await putWith(
            app,
            target,
            { cookie: "cire_org_session=not-a-live-session-token" },
            {
              allowed: true,
            },
          )
        ).status,
      ).toBe(401);
      expect(
        (await putWith(app, target, { authorization: "Bearer not-a-jwt" }, { allowed: true }))
          .status,
      ).toBe(401);
      expect((await put(app, target, STRANGER, { allowed: true })).status).toBe(403);
      expect(allowedOf(db, guestNamed(db, "Bo").id)).toBe(false);
    });
  }
});

describe("the organiser plus-one routes — the host-preview household", () => {
  it("404s both routes for the preview household, and changes nothing", async () => {
    const { db, app } = buildApp();
    const host = await hostHousehold(db);

    const one = await put(app, guestPath(host.guestId), OWNER, { allowed: true });
    expect(one.status).toBe(404);
    expect(await jsonBody(one)).toEqual({ error: "guest_not_found" });

    const all = await put(app, familyPath(host.familyId), OWNER, { allowed: true });
    expect(all.status).toBe(404);
    expect(await jsonBody(all)).toEqual({ error: "family_not_found" });

    expect(allowedOf(db, host.guestId)).toBe(false);
  });
});

describe("the organiser plus-one routes — metrics", () => {
  it("counts each permission write by scope and value, and each plus-one removed", async () => {
    const { db, app } = buildApp();
    const bo = guestNamed(db, "Bo");
    const set = (scope: string, allowed: string) =>
      counterValue(CIRE_METRICS.plusOnePermissionSet, { scope, allowed });
    const removed = () =>
      counterValue(CIRE_METRICS.plusOneChanged, { action: "removed", actor: "organiser" });

    const guestOn = await set("guest", "on");
    await put(app, guestPath(bo.id), OWNER, { allowed: true });
    expect(await set("guest", "on")).toBe(guestOn + 1);

    seedPlusOne(db, bo.id, { firstName: "Sam" });
    seedPlusOne(db, guestNamed(db, "Dot").id, { firstName: "Pat" });
    const householdOff = await set("household", "off");
    const removedBefore = await removed();
    // The refused call counts nothing.
    await put(app, familyPath(bo.familyId), OWNER, { allowed: false });
    expect(await set("household", "off")).toBe(householdOff);
    await put(app, familyPath(bo.familyId), OWNER, { allowed: false, removePlusOnes: true });
    expect(await set("household", "off")).toBe(householdOff + 1);
    expect(await removed()).toBe(removedBefore + 2);
  });
});
