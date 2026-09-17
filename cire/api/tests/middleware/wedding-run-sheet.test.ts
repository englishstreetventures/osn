import { describe, expect, it } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { runSheetVisibleTo } from "../../src/middleware/wedding-role";
import { weddingRunSheet } from "../../src/middleware/wedding-run-sheet";
import { appRequest, jsonBody } from "../test-helpers";

const WEDDING_ID = "wed_alice";
const OWNER = "usr_alice";
const EDITOR = "usr_bob";
const VIEWER = "usr_cleo";
const HELPER = "usr_dot";
const HELPER_FULL = "usr_eli";

const HELPER_SEAT = "whost_dot";
const HELPER_FULL_SEAT = "whost_eli";
const OTHER_SEAT = "whost_someone_else";

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
  const seat = (id: string, profile: string, role: "editor" | "viewer" | "helper") => ({
    id,
    weddingId: WEDDING_ID,
    osnProfileId: profile,
    addedByOsnProfileId: OWNER,
    role,
    createdAt: now,
  });
  db.insert(weddingHosts)
    .values(seat("whost_bob", EDITOR, "editor"))
    .run();
  db.insert(weddingHosts)
    .values(seat("whost_cleo", VIEWER, "viewer"))
    .run();
  // Left on the column default — the narrow scope a helper gets unless a host
  // opens the run sheet to them.
  db.insert(weddingHosts)
    .values(seat(HELPER_SEAT, HELPER, "helper"))
    .run();
  db.insert(weddingHosts)
    .values({ ...seat(HELPER_FULL_SEAT, HELPER_FULL, "helper"), runSheetScope: "full" })
    .run();
  return db;
}

/** Stands in for the upstream osnAuth() plugin by deriving a fixed profile. */
function buildApp(profileId?: string, db: Db = buildDb()) {
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId }))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingRunSheet(db))
        .get("/probe", ({ weddingRole, weddingHostId, weddingRunSheetScope }) => ({
          weddingRole,
          weddingHostId,
          weddingRunSheetScope,
        })),
    );
}

describe("weddingRunSheet — who reaches the run sheet", () => {
  it("admits a HELPER — the role every other gate turns away", async () => {
    const res = await appRequest(buildApp(HELPER), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      weddingRole: "helper",
      weddingHostId: HELPER_SEAT,
      weddingRunSheetScope: "own",
    });
  });

  it("admits the owner, with no seat id and the full run sheet", async () => {
    const res = await appRequest(buildApp(OWNER), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      weddingRole: "owner",
      weddingRunSheetScope: "full",
    });
  });

  it("admits an editor, scoped full", async () => {
    const res = await appRequest(buildApp(EDITOR), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toMatchObject({
      weddingRole: "editor",
      weddingRunSheetScope: "full",
    });
  });

  it("admits a viewer, scoped full — they already read the whole dashboard", async () => {
    const res = await appRequest(buildApp(VIEWER), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toMatchObject({
      weddingRole: "viewer",
      weddingRunSheetScope: "full",
    });
  });

  it("returns 403 forbidden for a stranger", async () => {
    const res = await appRequest(buildApp("usr_mallory"), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "forbidden" });
  });

  it("returns 404 when the wedding does not exist", async () => {
    const res = await appRequest(buildApp(OWNER), "/weddings/wed_nope/probe");
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "wedding_not_found" });
  });

  it("returns 401 when no osnProfileId was derived upstream", async () => {
    const res = await appRequest(buildApp(undefined), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(401);
  });
});

describe("weddingRunSheet — the stored scope", () => {
  it("honours a helper whose host opened the whole run sheet to them", async () => {
    const res = await appRequest(buildApp(HELPER_FULL), `/weddings/${WEDDING_ID}/probe`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      weddingRole: "helper",
      weddingHostId: HELPER_FULL_SEAT,
      weddingRunSheetScope: "full",
    });
  });

  it("defaults a helper to own without the column being written", async () => {
    // The seat above is inserted with no runSheetScope at all; the DDL default
    // is what makes the narrow value the one a new helper gets.
    const res = await appRequest(buildApp(HELPER), `/weddings/${WEDDING_ID}/probe`);
    expect(await jsonBody(res)).toMatchObject({ weddingRunSheetScope: "own" });
  });
});

describe("a helper scoped own receives no other person's assignments", () => {
  // The condition the epic sets, asserted on a real HTTP response body rather
  // than on what a page would render. The run-sheet route itself does not exist
  // yet; this mounts the real gate over a route that returns the real filter's
  // output, so the two halves that sub-issue 3 has to compose are proven to
  // compose here.
  const RUN_SHEET = [
    { id: "task_mine", title: "Carry the cake", assignedHostId: HELPER_SEAT },
    { id: "task_theirs", title: "Mind the rings", assignedHostId: OTHER_SEAT },
    { id: "task_nobodys", title: "Unassigned", assignedHostId: null },
  ];

  function buildRunSheetApp(profileId: string) {
    const db = buildDb();
    return new Elysia({ aot: false })
      .derive(() => ({ osnProfileId: profileId }))
      .group("/weddings/:weddingId", (group) =>
        group
          .use(weddingRunSheet(db))
          .get("/run-sheet", ({ weddingRunSheetScope, weddingHostId }) => ({
            tasks: runSheetVisibleTo(weddingRunSheetScope ?? "own", weddingHostId, RUN_SHEET),
          })),
      );
  }

  it("returns only the helper's own task in the body", async () => {
    const res = await appRequest(buildRunSheetApp(HELPER), `/weddings/${WEDDING_ID}/run-sheet`);
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as { tasks: { id: string }[] };
    expect(body.tasks.map((t) => t.id)).toEqual(["task_mine"]);
  });

  it("puts no other person's assignment anywhere in the serialised body", async () => {
    // Asserting on the raw text as well as the parsed list: a field added later
    // that carries another seat's work would pass the assertion above.
    const res = await appRequest(buildRunSheetApp(HELPER), `/weddings/${WEDDING_ID}/run-sheet`);
    const text = await res.text();
    expect(text).not.toContain(OTHER_SEAT);
    expect(text).not.toContain("Mind the rings");
  });

  it("returns the whole run sheet to a helper the host has opened it to", async () => {
    const res = await appRequest(
      buildRunSheetApp(HELPER_FULL),
      `/weddings/${WEDDING_ID}/run-sheet`,
    );
    const body = (await jsonBody(res)) as { tasks: { id: string }[] };
    expect(body.tasks.map((t) => t.id)).toEqual(["task_mine", "task_theirs", "task_nobodys"]);
  });

  it("returns the whole run sheet to the owner", async () => {
    const res = await appRequest(buildRunSheetApp(OWNER), `/weddings/${WEDDING_ID}/run-sheet`);
    const body = (await jsonBody(res)) as { tasks: { id: string }[] };
    expect(body.tasks).toHaveLength(RUN_SHEET.length);
  });
});

describe("runSheetVisibleTo", () => {
  const items = [
    { assignedHostId: "whost_a" },
    { assignedHostId: "whost_b" },
    { assignedHostId: null },
  ];

  it("passes everything through at full scope", () => {
    expect(runSheetVisibleTo("full", "whost_a", items)).toEqual(items);
  });

  it("keeps only the caller's own rows at own scope", () => {
    expect(runSheetVisibleTo("own", "whost_a", items)).toEqual([{ assignedHostId: "whost_a" }]);
  });

  it("treats an unassigned row as nobody's, not everybody's", () => {
    expect(runSheetVisibleTo("own", "whost_a", items)).not.toContainEqual({ assignedHostId: null });
  });

  it("returns nothing at own scope when the caller has no seat id", () => {
    // Fails closed: without a seat there is nothing that is the caller's own,
    // so the answer is an empty list rather than the whole run sheet.
    expect(runSheetVisibleTo("own", undefined, items)).toEqual([]);
  });
});
