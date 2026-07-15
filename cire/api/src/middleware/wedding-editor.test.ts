import { describe, it, expect } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../db";
import { createDb } from "../db/setup";
import { appRequest } from "../test-helpers";
import { weddingEditor } from "./wedding-editor";

const WEDDING_ID = "wed_alice";
const OWNER = "usr_alice";
const EDITOR = "usr_bob";
const VIEWER = "usr_carol";
const LEGACY_HOST = "usr_dora";

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
      osnProfileId: EDITOR,
      addedByOsnProfileId: OWNER,
      role: "editor",
      createdAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values({
      id: "whost_carol",
      weddingId: WEDDING_ID,
      osnProfileId: VIEWER,
      addedByOsnProfileId: OWNER,
      role: "viewer",
      createdAt: now,
    })
    .run();
  // Pre-0031 seat shape: no explicit role → the column's legacy DDL DEFAULT
  // 'host'. The gate must treat it as an editor.
  db.insert(weddingHosts)
    .values({
      id: "whost_dora",
      weddingId: WEDDING_ID,
      osnProfileId: LEGACY_HOST,
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
      group.use(weddingEditor(db)).get("/probe", ({ weddingId, weddingIsOwner, weddingRole }) => ({
        weddingId,
        weddingIsOwner,
        weddingRole,
      })),
    );
}

describe("weddingEditor", () => {
  it("admits the owner", async () => {
    const app = buildApp(OWNER);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      weddingId: WEDDING_ID,
      weddingIsOwner: true,
      weddingRole: "owner",
    });
  });

  it("admits an editor co-host", async () => {
    const app = buildApp(EDITOR);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      weddingId: WEDDING_ID,
      weddingIsOwner: false,
      weddingRole: "editor",
    });
  });

  it("admits a legacy 'host' seat as an editor (normalisation)", async () => {
    const app = buildApp(LEGACY_HOST);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { weddingRole: string }).weddingRole).toBe("editor");
  });

  it("rejects a viewer co-host with 403 read_only_role", async () => {
    const app = buildApp(VIEWER);
    const res = await appRequest(app, `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "read_only_role" });
  });

  it("returns 403 forbidden for a stranger (neither owner nor host)", async () => {
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
