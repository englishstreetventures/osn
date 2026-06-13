import { describe, it, expect } from "bun:test";

import { weddings } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../db";
import { createDb } from "../db/setup";
import { appRequest } from "../test-helpers";
import { ownedWedding } from "./owned-wedding";

const OWNER = "usr_alice";

/**
 * Seed `count` weddings all owned by OWNER. Each gets a distinct id/slug and a
 * staggered createdAt so the plugin's `ORDER BY created_at ASC` is
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

/** Stands in for the upstream osnAuth() plugin by deriving a fixed profile. */
function buildApp(weddingCount: number, profileId?: string) {
  const db = buildDb(weddingCount);
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId }))
    .use(ownedWedding(db))
    .get("/probe", ({ weddingId }) => ({ weddingId }));
}

describe("ownedWedding", () => {
  it("returns 400 multiple_weddings when the caller owns more than one wedding", async () => {
    const app = buildApp(2, OWNER);
    const res = await appRequest(app, "/probe");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "multiple_weddings",
      hint: "use /api/organiser/weddings/:weddingId/...",
    });
  });

  it("returns 401 when no osnProfileId was derived upstream", async () => {
    const app = buildApp(1, undefined);
    const res = await appRequest(app, "/probe");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorised" });
  });

  it("returns 404 no_weddings when the caller owns nothing", async () => {
    const app = buildApp(0, OWNER);
    const res = await appRequest(app, "/probe");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_weddings" });
  });

  it("derives weddingId as the single owned wedding", async () => {
    const app = buildApp(1, OWNER);
    const res = await appRequest(app, "/probe");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weddingId: "wed_0" });
  });
});
