import { describe, it, expect } from "bun:test";

import { families } from "@cire/db";
import { Effect } from "effect";
import { Hono } from "hono";

import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { sessionService } from "../services/session";
import { sessionAuth } from "./auth";

interface Vars {
  db: Db;
  familyId: string;
}

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  app.use("/private", sessionAuth());
  app.get("/private", (c) => c.json({ familyId: c.var.familyId }));
  return { app, db };
}

describe("sessionAuth middleware", () => {
  it("returns 401 when there is no Cookie header", async () => {
    const { app } = buildApp();
    const res = await app.fetch(new Request("http://localhost/private"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Cookie header has no cire_session entry", async () => {
    const { app } = buildApp();
    const res = await app.fetch(
      new Request("http://localhost/private", {
        headers: { Cookie: "other=foo; pref=dark" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown session token", async () => {
    const { app } = buildApp();
    const res = await app.fetch(
      new Request("http://localhost/private", {
        headers: { Cookie: "cire_session=not-a-real-token" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 + sets familyId for a valid session", async () => {
    const { app, db } = buildApp();
    const [first] = db.select({ id: families.id }).from(families).all();
    const familyId = first!.id;
    const { token } = await Effect.runPromise(
      sessionService.create(familyId).pipe(Effect.provideService(DbService, db)),
    );

    const res = await app.fetch(
      new Request("http://localhost/private", {
        headers: { Cookie: `cire_session=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { familyId: string };
    expect(body.familyId).toBe(familyId);
  });

  it("returns 401 for an expired token", async () => {
    const { app, db } = buildApp();
    const [first] = db.select({ id: families.id }).from(families).all();
    const familyId = first!.id;
    // ttl=0 → expiresAt == now → already expired by the time validate runs.
    const { token } = await Effect.runPromise(
      sessionService.create(familyId, 0).pipe(Effect.provideService(DbService, db)),
    );
    const res = await app.fetch(
      new Request("http://localhost/private", {
        headers: { Cookie: `cire_session=${token}` },
      }),
    );
    expect(res.status).toBe(401);
  });
});
