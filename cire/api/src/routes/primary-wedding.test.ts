import { describe, it, expect } from "bun:test";

import { weddings } from "@cire/db";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb, seedBootstrapWedding } from "../db/setup";
import { appRequest } from "../test-helpers";

/**
 * `GET /api/primary-wedding` drives the guest site's bare-domain (`/`) route:
 * it resolves the deployment's default wedding slug so `/` can 302 to `/<slug>`
 * with NO build-time slug variable. Public read, no auth.
 */

function appWith(seed: (db: Db) => void) {
  const db = createDb(":memory:");
  seed(db);
  const app = createApp(db);
  return { db, app };
}

function seedExtraWedding(db: Db, id: string, slug: string, createdAt: Date) {
  db.insert(weddings)
    .values({
      id,
      slug,
      displayName: slug,
      ownerOsnProfileId: "usr_owner",
      createdAt,
      updatedAt: createdAt,
    })
    .run();
}

describe("GET /api/primary-wedding", () => {
  it("returns the sole wedding's slug when exactly one exists", async () => {
    // seedDb seeds the single bootstrap wedding (slug `cire-wedding`).
    const { app } = appWith(seedDb);
    const res = await appRequest(app, "/api/primary-wedding");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe("cire-wedding");
  });

  it("returns no-store so a freshly-created wedding isn't served stale", async () => {
    const { app } = appWith(seedDb);
    const res = await appRequest(app, "/api/primary-wedding");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns the MOST-RECENTLY-CREATED wedding when several exist", async () => {
    const { app } = appWith((db) => {
      // Bootstrap wedding is created at `now`; seed two more with explicit
      // older/newer timestamps so the ordering is deterministic.
      seedBootstrapWedding(db);
      seedExtraWedding(db, "wed_old", "old-wedding", new Date(1_000_000_000_000));
      seedExtraWedding(db, "wed_new", "newest-wedding", new Date(2_000_000_000_000));
    });
    const res = await appRequest(app, "/api/primary-wedding");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe("newest-wedding");
  });

  it("404s when no wedding is configured (neutral state for the `/` route)", async () => {
    // Bare DB, no seed — a fresh deployment before any wedding is created.
    const { app } = appWith(() => {});
    const res = await appRequest(app, "/api/primary-wedding");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not found");
  });

  it("needs no auth (the slug is the public invite URL)", async () => {
    const { app } = appWith(seedDb);
    // No Authorization header, no cookie — still 200.
    const res = await appRequest(app, "/api/primary-wedding");
    expect(res.status).toBe(200);
  });
});
