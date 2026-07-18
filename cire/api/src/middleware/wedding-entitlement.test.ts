import { describe, it, expect } from "bun:test";

import { weddings } from "@cire/db";
import { Effect } from "effect";
import { Elysia } from "elysia";

import type { Db } from "../db";
import { DbService } from "../db";
import { createDb } from "../db/setup";
import { entitlementService } from "../services/entitlements";
import { appRequest } from "../test-helpers";
import { weddingEntitlement } from "./wedding-entitlement";

/** A stub Db whose every query throws a transient error — simulates D1 defect. */
function buildThrowingDb(): Db {
  return new Proxy({} as Db, {
    get() {
      return () => {
        throw new Error("simulated D1 transient failure");
      };
    },
  });
}

function buildDb(): Db {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(weddings)
    .values({
      id: "wed_x",
      slug: "wed-x-slug",
      displayName: "Wedding X",
      ownerOsnProfileId: "usr_o",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(weddings)
    .values({
      id: "wed_y",
      slug: "wed-y-slug",
      displayName: "Wedding Y",
      ownerOsnProfileId: "usr_o",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return db;
}

function appFor(db: Db) {
  return new Elysia({ aot: false }).group("/w/:weddingId", (g) =>
    g.use(weddingEntitlement(db, "vendors")).get("/thing", () => ({ ok: true })),
  );
}

describe("weddingEntitlement", () => {
  it("fails closed (402) when the DB throws a defect — never grants on error", async () => {
    const throwingDb = buildThrowingDb();
    const app = new Elysia({ aot: false }).group("/w/:weddingId", (g) =>
      g.use(weddingEntitlement(throwingDb, "vendors")).get("/thing", () => ({ ok: true })),
    );
    const res = await appRequest(app, "/w/wed_x/thing");
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "payment_required", entitlement: "vendors" });
  });

  it("402 payment_required + entitlement when the wedding lacks the pack", async () => {
    const db = buildDb();
    const res = await appRequest(appFor(db), "/w/wed_x/thing");
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "payment_required", entitlement: "vendors" });
  });

  it("passes through when the wedding holds the pack", async () => {
    const db = buildDb();
    await Effect.runPromise(
      entitlementService
        .grant("wed_y", "vendors", { source: "comp", grantedBy: "usr_o" })
        .pipe(Effect.provideService(DbService, db)) as Effect.Effect<void, never, never>,
    );
    const res = await appRequest(appFor(db), "/w/wed_y/thing");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
