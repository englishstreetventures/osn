import { describe, it, expect } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../db";
import { createDb } from "../db/setup";
import { appRequest } from "../test-helpers";
import { weddingMember } from "./wedding-member";

const WEDDING_ID = "wed_alice";
const OWNER = "usr_alice";
const COHOST = "usr_bob";

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
    expect(await res.json()).toEqual({ weddingId: WEDDING_ID, weddingIsOwner: true });
  });

  it("admits a co-host and marks weddingIsOwner:false", async () => {
    const app = buildApp(COHOST);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weddingId: WEDDING_ID, weddingIsOwner: false });
  });

  it("returns 403 for a stranger (neither owner nor host)", async () => {
    const app = buildApp("usr_mallory");
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
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
