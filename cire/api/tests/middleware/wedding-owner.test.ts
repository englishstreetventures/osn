import { describe, it, expect } from "bun:test";

import { weddingHosts } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { weddingOwner } from "../../src/middleware/wedding-owner";
import { appRequest, jsonBody } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

const WEDDING_ID = "wed_alice";
const OWNER = "usr_alice";

const CO_OWNER = "usr_ben";

function buildDb(): Db {
  const db = createDb(":memory:");
  const now = new Date();
  insertWedding(db, {
    id: WEDDING_ID,
    slug: "alice-wedding",
    displayName: "Alice's Wedding",
    createdAt: now,
    updatedAt: now,
    owners: [OWNER, CO_OWNER],
  });
  for (const [osnProfileId, role] of [
    ["usr_editor", "editor"],
    ["usr_viewer", "viewer"],
    ["usr_helper", "helper"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id: `whost_${osnProfileId}`,
        weddingId: WEDDING_ID,
        osnProfileId,
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
      group.use(weddingOwner(db)).get("/probe", ({ weddingId }) => ({ weddingId })),
    );
}

describe("weddingOwner", () => {
  it("returns 403 when the caller does not own the wedding", async () => {
    const app = buildApp("usr_mallory");
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "forbidden" });
  });

  it("returns 200 and derives weddingId when the owner matches", async () => {
    const app = buildApp(OWNER);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ weddingId: WEDDING_ID });
  });

  it("admits a second owner exactly as the first", async () => {
    const app = buildApp(CO_OWNER);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ weddingId: WEDDING_ID });
  });

  it("refuses every seat below owner with the plain forbidden a stranger gets", async () => {
    // Never a role's own refusal string: a viewer's `read_only_role` tells the
    // portal to ask for editor access, which would not open this surface.
    for (const caller of ["usr_editor", "usr_viewer", "usr_helper"]) {
      const res = await appRequest(buildApp(caller), `/weddings/${WEDDING_ID}/probe`);
      expect(res.status).toBe(403);
      expect(await jsonBody(res)).toEqual({ error: "forbidden" });
    }
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
});
