import { describe, it, expect } from "bun:test";

import { weddings } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../db";
import { createDb } from "../db/setup";
import { appRequest } from "../test-helpers";
import { weddingOwner } from "./wedding-owner";

const WEDDING_ID = "wed_alice";
const OWNER = "usr_alice";

function buildDb(): Db {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(weddings)
    .values({
      id: WEDDING_ID,
      slug: "alice-wedding",
      displayName: "Alice's Wedding",
      ownerOsnProfileId: OWNER,
      createdAt: now,
      updatedAt: now,
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
      group.use(weddingOwner(db)).get("/probe", ({ weddingId }) => ({ weddingId })),
    );
}

describe("weddingOwner", () => {
  it("returns 403 when the caller does not own the wedding", async () => {
    const app = buildApp("usr_mallory");
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("returns 200 and derives weddingId when the owner matches", async () => {
    const app = buildApp(OWNER);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weddingId: WEDDING_ID });
  });

  it("returns 404 when the wedding does not exist", async () => {
    const app = buildApp(OWNER);
    const res = await appRequest(app, "/weddings/wed_nope/probe");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "wedding_not_found" });
  });

  it("returns 401 when no osnProfileId was derived upstream", async () => {
    const app = buildApp(undefined);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(401);
  });
});
