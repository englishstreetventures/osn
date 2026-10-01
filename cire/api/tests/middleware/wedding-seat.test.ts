import { describe, expect, it } from "bun:test";

import { weddingHosts } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { weddingSeat } from "../../src/middleware/wedding-seat";
import { appRequest, jsonBody } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

const WEDDING_ID = "wed_alice";
const OWNER = "usr_alice";

function buildDb(): Db {
  const db = createDb(":memory:");
  const now = new Date();
  insertWedding(db, {
    id: WEDDING_ID,
    slug: "alice-wedding",
    displayName: "Alice's Wedding",
    owners: [OWNER],
    createdAt: now,
  });
  for (const [profile, role] of [
    ["usr_bob", "editor"],
    ["usr_cleo", "viewer"],
    ["usr_dot", "helper"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id: `whost_${profile}`,
        weddingId: WEDDING_ID,
        osnProfileId: profile,
        addedByOsnProfileId: OWNER,
        role,
        createdAt: now,
      })
      .run();
  }
  return db;
}

/** Stands in for the upstream osnAuth() plugin by deriving a fixed profile. */
function buildApp(profileId?: string) {
  const db = buildDb();
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId }))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingSeat(db))
        .get("/probe", ({ weddingRole, weddingIsOwner }) => ({ weddingRole, weddingIsOwner })),
    );
}

describe("weddingSeat — anyone holding a seat", () => {
  for (const [profile, role] of [
    ["usr_bob", "editor"],
    ["usr_cleo", "viewer"],
    ["usr_dot", "helper"],
  ] as const) {
    it(`admits a ${role}`, async () => {
      const res = await appRequest(buildApp(profile), `/weddings/${WEDDING_ID}/probe`);
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ weddingRole: role, weddingIsOwner: false });
    });
  }

  it("admits the owner, flagged as owner so a route can refuse them", async () => {
    const res = await appRequest(buildApp(OWNER), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ weddingRole: "owner", weddingIsOwner: true });
  });

  it("returns 403 forbidden for a stranger", async () => {
    const res = await appRequest(buildApp("usr_mallory"), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "forbidden" });
  });

  it("returns 404 when the wedding does not exist", async () => {
    const res = await appRequest(buildApp(OWNER), "/weddings/wed_nope/probe");
    expect(res.status).toBe(404);
  });

  it("returns 401 with no caller", async () => {
    const res = await appRequest(buildApp(undefined), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(401);
  });
});
