import { describe, it, expect } from "bun:test";

import { weddings } from "@cire/db";
import { Hono } from "hono";

import type { Db } from "../db";
import { createDb } from "../db/setup";
import { ownedWedding } from "./owned-wedding";

const OWNER = "usr_alice";

/**
 * Seed `count` weddings all owned by OWNER. Each gets a distinct id/slug and a
 * staggered createdAt so the middleware's `ORDER BY created_at ASC` is
 * deterministic (the single-wedding case asserts it picks the earliest).
 */
function buildDb(count: number): Db {
  const db = createDb(":memory:");
  for (let i = 0; i < count; i++) {
    db.insert(weddings)
      .values({
        id: `wed_${i}`,
        slug: `wedding-${i}`,
        displayName: `Wedding ${i}`,
        ownerOsnProfileId: OWNER,
        createdAt: new Date(1_000 + i),
        updatedAt: new Date(1_000 + i),
      })
      .run();
  }
  return db;
}

function buildApp(weddingCount: number, profileId?: string) {
  const db = buildDb(weddingCount);
  const app = new Hono<{
    Variables: { db: Db; osnProfileId?: string; weddingId?: string };
  }>();
  app.use("*", (c, next) => {
    c.set("db", db);
    if (profileId) c.set("osnProfileId", profileId);
    return next();
  });
  app.use("/probe", ownedWedding());
  app.get("/probe", (c) => c.json({ weddingId: c.var.weddingId ?? null }));
  return app;
}

describe("ownedWedding", () => {
  it("returns 400 multiple_weddings when the caller owns more than one wedding", async () => {
    const app = buildApp(2, OWNER);
    const res = await app.request("/probe");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "multiple_weddings",
      hint: "use /api/organiser/weddings/:weddingId/...",
    });
  });

  it("returns 401 when no osnProfileId was set upstream", async () => {
    const app = buildApp(1, undefined);
    const res = await app.request("/probe");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorised" });
  });

  it("returns 404 no_weddings when the caller owns nothing", async () => {
    const app = buildApp(0, OWNER);
    const res = await app.request("/probe");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_weddings" });
  });

  it("sets c.var.weddingId to the single owned wedding", async () => {
    const app = buildApp(1, OWNER);
    const res = await app.request("/probe");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weddingId: "wed_0" });
  });
});
