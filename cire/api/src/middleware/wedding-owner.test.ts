import { describe, it, expect } from "bun:test";

import { weddings } from "@cire/db";
import { Hono } from "hono";

import type { Db } from "../db";
import { createDb } from "../db/setup";
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

function buildApp(profileId?: string) {
  const db = buildDb();
  const app = new Hono<{
    Variables: { db: Db; osnProfileId?: string; weddingId?: string };
  }>();
  app.use("*", (c, next) => {
    c.set("db", db);
    if (profileId) c.set("osnProfileId", profileId);
    return next();
  });
  app.use("/weddings/:weddingId/*", weddingOwner());
  app.get("/weddings/:weddingId/probe", (c) => c.json({ weddingId: c.var.weddingId ?? null }));
  return app;
}

describe("weddingOwner", () => {
  it("returns 403 when the caller does not own the wedding", async () => {
    const app = buildApp("usr_mallory");
    const res = await app.request(`/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("returns 200 and sets c.var.weddingId when the owner matches", async () => {
    const app = buildApp(OWNER);
    const res = await app.request(`/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weddingId: WEDDING_ID });
  });

  it("returns 404 when the wedding does not exist", async () => {
    const app = buildApp(OWNER);
    const res = await app.request("/weddings/wed_nope/probe");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "wedding_not_found" });
  });

  it("returns 401 when no osnProfileId was set upstream", async () => {
    const app = buildApp(undefined);
    const res = await app.request(`/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(401);
  });
});
