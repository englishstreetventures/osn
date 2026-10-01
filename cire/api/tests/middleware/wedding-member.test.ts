import { describe, it, expect } from "bun:test";

import { weddingHosts } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { weddingMember } from "../../src/middleware/wedding-member";
import { appRequest, jsonBody } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

const WEDDING_ID = "wed_alice";
const OWNER = "usr_alice";
const COHOST = "usr_bob";

function buildDb(): Db {
  const db = createDb(":memory:");
  const now = new Date();
  insertWedding(db, {
    id: WEDDING_ID,
    slug: "alice-wedding",
    displayName: "Alice's Wedding",
    createdAt: now,
    updatedAt: now,
    owners: [OWNER],
  });
  db.insert(weddingHosts)
    .values({
      id: "whost_bob",
      weddingId: WEDDING_ID,
      osnProfileId: COHOST,
      addedByOsnProfileId: OWNER,
      createdAt: now,
    })
    .run();
  return db;
}

/** Stands in for the upstream osnAuth() plugin by deriving a fixed profile. */
function buildApp(profileId?: string) {
  const db = buildDb();
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId }))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .get("/probe", ({ weddingId, weddingIsOwner }) => ({ weddingId, weddingIsOwner })),
    );
}

describe("weddingMember", () => {
  it("admits the owner and marks weddingIsOwner:true", async () => {
    const app = buildApp(OWNER);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ weddingId: WEDDING_ID, weddingIsOwner: true });
  });

  it("admits a co-host and marks weddingIsOwner:false", async () => {
    const app = buildApp(COHOST);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ weddingId: WEDDING_ID, weddingIsOwner: false });
  });

  it("admits a VIEWER co-host too (reads are role-agnostic)", async () => {
    const db = buildDb();
    db.insert(weddingHosts)
      .values({
        id: "whost_viewer",
        weddingId: WEDDING_ID,
        osnProfileId: "usr_viewer",
        addedByOsnProfileId: OWNER,
        role: "viewer",
        createdAt: new Date(),
      })
      .run();
    const app = new Elysia({ aot: false })
      .derive(() => ({ osnProfileId: "usr_viewer" }))
      .group("/weddings/:weddingId", (group) =>
        group.use(weddingMember(db)).get("/probe", ({ weddingRole }) => ({ weddingRole })),
      );
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ weddingRole: "viewer" });
  });

  it("REFUSES a helper — the read surface is not theirs", async () => {
    // A helper holds a real seat on this wedding and is still turned away:
    // this gate fronts the guest list, the budget, the registry, the vendors
    // and the RSVPs, and a helper is someone handed a job on the day.
    const db = buildDb();
    db.insert(weddingHosts)
      .values({
        id: "whost_helper",
        weddingId: WEDDING_ID,
        osnProfileId: "usr_helper",
        addedByOsnProfileId: OWNER,
        role: "helper",
        createdAt: new Date(),
      })
      .run();
    const app = new Elysia({ aot: false })
      .derive(() => ({ osnProfileId: "usr_helper" }))
      .group("/weddings/:weddingId", (group) =>
        group.use(weddingMember(db)).get("/probe", ({ weddingRole }) => ({ weddingRole })),
      );
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(403);
    // The same body a stranger gets, so a probe cannot tell a helper's seat
    // from no seat at all.
    expect(await jsonBody(res)).toEqual({ error: "forbidden" });
  });

  it("returns 403 for a stranger (neither owner nor host)", async () => {
    const app = buildApp("usr_mallory");
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "forbidden" });
  });

  it("returns 404 when the wedding does not exist", async () => {
    const app = buildApp(OWNER);
    const res = await appRequest(app, "/weddings/wed_nope/probe");
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "wedding_not_found" });
  });

  it("returns 401 when no osnProfileId was derived upstream", async () => {
    const app = buildApp(undefined);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(401);
  });

  it("admits a second owner as an owner — every owner passes alike", async () => {
    const db = buildDb();
    db.insert(weddingHosts)
      .values({
        id: "whost_coowner",
        weddingId: WEDDING_ID,
        osnProfileId: "usr_coowner",
        addedByOsnProfileId: OWNER,
        role: "owner",
        createdAt: new Date(),
      })
      .run();
    const app = new Elysia({ aot: false })
      .derive(() => ({ osnProfileId: "usr_coowner" }))
      .group("/weddings/:weddingId", (group) =>
        group
          .use(weddingMember(db))
          .get("/probe", ({ weddingIsOwner, weddingRole }) => ({ weddingIsOwner, weddingRole })),
      );
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ weddingIsOwner: true, weddingRole: "owner" });
  });

  it("derives the wedding's slug for the owner and a co-host alike", async () => {
    // The CSV exports name their download after the slug, and take it from
    // here rather than reading the wedding row again.
    const db = buildDb();
    const slugApp = (profileId: string) =>
      new Elysia({ aot: false })
        .derive(() => ({ osnProfileId: profileId }))
        .group("/weddings/:weddingId", (group) =>
          group.use(weddingMember(db)).get("/probe", ({ weddingSlug }) => ({ weddingSlug })),
        );
    const asOwner = await appRequest(slugApp(OWNER), `/weddings/${WEDDING_ID}/probe`);
    const asCohost = await appRequest(slugApp(COHOST), `/weddings/${WEDDING_ID}/probe`);
    expect(await jsonBody(asOwner)).toEqual({ weddingSlug: "alice-wedding" });
    expect(await jsonBody(asCohost)).toEqual({ weddingSlug: "alice-wedding" });
  });
});
