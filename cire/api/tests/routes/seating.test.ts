import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guestEvents,
  guests,
  rsvps,
  seatingAssignments,
  seatingTables,
  weddingHosts,
} from "@cire/db";
import { and, eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { appRequest, jsonBody, setTier } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

// The seating chart's routes over the real app on bun:sqlite. Every case maps
// to a failure mode listed for this module before its code was written:
// who may read and write, what the database refuses, which guests a chart
// shows, and what the venue file prints.

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const HELPER = "usr_helper";
const STRANGER = "usr_bob";

const W = BOOTSTRAP_WEDDING_ID;
const REC = "evt_rec";
const CER = "evt_cer";
const OTHER_EVENT = "evt_other";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/**
 * One wedding with two events — the reception has no stated end (`""`) — and
 * four households: Alpha (Ada, Bo), the host-preview household, a withdrawn
 * household (Gwen) and Charlie (Cy, invited to the ceremony only). A second
 * wedding owned by a stranger has its own event, household and guest.
 */
function buildDb(tier: "ivory" | "gold" | "crimson" = "gold"): TestDb {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const now = new Date();
  for (const [id, osnProfileId, role] of [
    ["whost_editor", EDITOR, "editor"],
    ["whost_viewer", VIEWER, "viewer"],
    ["whost_helper", HELPER, "helper"],
  ] as const) {
    db.insert(weddingHosts)
      .values({ id, weddingId: W, osnProfileId, addedByOsnProfileId: OWNER, role, createdAt: now })
      .run();
  }
  insertWedding(db, { id: "wed_other", slug: "other", displayName: "Other", owners: [STRANGER] });
  setTier(db, W, tier);
  setTier(db, "wed_other", "gold");

  db.insert(events)
    .values([
      {
        id: REC,
        weddingId: W,
        slug: "reception",
        name: "Reception",
        startAt: "2027-03-01T18:00",
        endAt: "",
        timezone: "Australia/Sydney",
        sortOrder: 1,
      },
      {
        id: CER,
        weddingId: W,
        slug: "ceremony",
        name: "Ceremony",
        startAt: "2027-03-01T15:00",
        endAt: "2027-03-01T16:00",
        timezone: "Australia/Sydney",
        sortOrder: 0,
      },
      {
        id: OTHER_EVENT,
        weddingId: "wed_other",
        slug: "reception",
        name: "Other reception",
        startAt: "2027-04-01T18:00",
        endAt: "",
        timezone: "UTC",
        sortOrder: 0,
      },
    ])
    .run();

  const family = (id: string, weddingId: string, familyName: string, extra = {}) =>
    db
      .insert(families)
      .values({
        id,
        weddingId,
        publicId: `CODE-${id}`,
        familyName,
        createdAt: now,
        updatedAt: now,
        ...extra,
      })
      .run();
  family("fam_a", W, "Alpha");
  family("fam_host", W, "Host", { kind: "host" });
  family("fam_gone", W, "Gone", { deactivatedAt: now });
  family("fam_c", W, "Charlie");
  family("fam_x", "wed_other", "Xeno");

  const guest = (id: string, familyId: string, firstName: string, sortOrder = 0) =>
    db
      .insert(guests)
      .values({ id, familyId, firstName, lastName: "", sortOrder, createdAt: now, updatedAt: now })
      .run();
  guest("g_ada", "fam_a", "Ada", 0);
  guest("g_bo", "fam_a", "Bo", 1);
  guest("g_host", "fam_host", "Host");
  guest("g_gone", "fam_gone", "Gwen");
  guest("g_cy", "fam_c", "Cy");
  guest("g_xeno", "fam_x", "Xeno");

  db.insert(guestEvents)
    .values([
      { guestId: "g_ada", eventId: REC },
      { guestId: "g_ada", eventId: CER },
      { guestId: "g_bo", eventId: REC },
      { guestId: "g_host", eventId: REC },
      { guestId: "g_host", eventId: CER },
      { guestId: "g_gone", eventId: REC },
      { guestId: "g_cy", eventId: CER },
      { guestId: "g_xeno", eventId: OTHER_EVENT },
    ])
    .run();
  db.insert(rsvps)
    .values([
      { id: "rsvp_ada", guestId: "g_ada", eventId: REC, status: "attending", createdAt: now },
      { id: "rsvp_bo", guestId: "g_bo", eventId: REC, status: "declined", createdAt: now },
    ])
    .run();
  return db;
}

function setup(tier: "ivory" | "gold" | "crimson" = "gold") {
  const db = buildDb(tier);
  return { db, app: createApp(db, { osnTestKey: auth.key }) };
}
type App = ReturnType<typeof setup>["app"];

async function req(
  app: App,
  method: string,
  path: string,
  profileId: string | undefined,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const base = `/api/organiser/weddings/${W}`;
const chartPath = (eventId: string) => `${base}/seating/events/${eventId}`;
const tablesPath = (eventId: string) => `${base}/seating/events/${eventId}/tables`;
const tablePath = (tableId: string) => `${base}/seating/tables/${tableId}`;
const seatPath = (eventId: string, guestId: string) =>
  `${base}/seating/events/${eventId}/guests/${guestId}`;

interface TableDto {
  id: string;
  name: string;
  capacity: number;
  sortOrder: number;
}
interface GuestDto {
  id: string;
  firstName: string;
  lastName: string;
  rsvp: string | null;
  withdrawn: boolean;
  tableId: string | null;
}
interface ChartDto {
  event: { id: string; name: string };
  tables: TableDto[];
  guests: GuestDto[];
}

async function createTable(app: App, eventId: string, name: string, capacity = 8) {
  const res = await req(app, "POST", tablesPath(eventId), EDITOR, { name, capacity });
  expect(res.status).toBe(200);
  return ((await res.json()) as { table: TableDto }).table;
}

async function chart(app: App, eventId: string, as = EDITOR): Promise<ChartDto> {
  const res = await req(app, "GET", chartPath(eventId), as);
  expect(res.status).toBe(200);
  return (await res.json()) as ChartDto;
}

const seatsOf = (db: TestDb, eventId: string) =>
  db
    .select({ tableId: seatingAssignments.tableId, guestId: seatingAssignments.guestId })
    .from(seatingAssignments)
    .where(eq(seatingAssignments.eventId, eventId))
    .all()
    .toSorted((a, b) => a.guestId.localeCompare(b.guestId));

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("seating — who may read and write", () => {
  it("answers 401 without a token, on reads and writes", async () => {
    const { app } = setup();
    expect((await req(app, "GET", chartPath(REC), undefined)).status).toBe(401);
    expect(
      (await req(app, "POST", tablesPath(REC), undefined, { name: "T", capacity: 8 })).status,
    ).toBe(401);
  });

  it("takes a live session cookie, and refuses a dead one or a malformed token", async () => {
    const { app, db } = setup();
    const token = await seedOrganiserSession(db, EDITOR);
    const withCookie = (cookie: string, method: string, path: string, body?: unknown) =>
      appRequest(app, path, {
        method,
        headers: { "Content-Type": "application/json", cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await withCookie(`cire_org_session=${token}`, "GET", chartPath(REC))).status).toBe(200);
    const created = await withCookie(`cire_org_session=${token}`, "POST", tablesPath(REC), {
      name: "By cookie",
      capacity: 8,
    });
    expect(created.status).toBe(200);

    const dead = "cire_org_session=not-a-live-session-token";
    expect((await withCookie(dead, "GET", chartPath(REC))).status).toBe(401);
    expect(
      (await withCookie(dead, "POST", tablesPath(REC), { name: "Dead", capacity: 8 })).status,
    ).toBe(401);
    const badBearer = await appRequest(app, tablesPath(REC), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-jwt" },
      body: JSON.stringify({ name: "Bad", capacity: 8 }),
    });
    expect(badBearer.status).toBe(401);
    expect(db.select({ name: seatingTables.name }).from(seatingTables).all()).toEqual([
      { name: "By cookie" },
    ]);
  });

  it("refuses a member of another wedding, reading or writing", async () => {
    const { app } = setup();
    expect((await req(app, "GET", chartPath(REC), STRANGER)).status).toBe(403);
    const res = await req(app, "POST", tablesPath(REC), STRANGER, { name: "T", capacity: 8 });
    expect(res.status).toBe(403);
  });

  it("refuses a helper seat, reading or writing", async () => {
    const { app } = setup();
    const read = await req(app, "GET", chartPath(REC), HELPER);
    expect(read.status).toBe(403);
    expect(await errorOf(read)).toBe("forbidden");
    const write = await req(app, "POST", tablesPath(REC), HELPER, { name: "T", capacity: 8 });
    expect(write.status).toBe(403);
    expect(await errorOf(write)).toBe("forbidden");
  });

  it("lets a viewer read the chart but not change it", async () => {
    const { app, db } = setup();
    const table = await createTable(app, REC, "Table 1");
    expect((await req(app, "GET", chartPath(REC), VIEWER)).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", tablesPath(REC), { name: "T", capacity: 8 }],
      ["PATCH", tablePath(table.id), { name: "Renamed" }],
      ["DELETE", tablePath(table.id), undefined],
      ["PATCH", `${tablesPath(REC)}/reorder`, { orderedIds: [table.id] }],
      ["PUT", seatPath(REC, "g_ada"), { tableId: table.id }],
    ] as const) {
      const res = await req(app, method, path, VIEWER, body);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
      expect(await errorOf(res)).toBe("read_only_role");
    }
    expect(seatsOf(db, REC)).toEqual([]);
  });

  it("answers 402 naming Gold to a wedding below it, reading and writing", async () => {
    const { app } = setup("ivory");
    for (const [method, path, body] of [
      ["GET", chartPath(REC), undefined],
      ["POST", tablesPath(REC), { name: "T", capacity: 8 }],
      ["PUT", seatPath(REC, "g_ada"), { tableId: null }],
    ] as const) {
      const res = await req(app, method, path, OWNER, body);
      expect(res.status).toBe(402);
      expect(await jsonBody(res)).toEqual({ error: "payment_required", tier: "gold" });
    }
  });

  it("serves the venue file to an owner on any tier, and to nobody else", async () => {
    const { app } = setup("ivory");
    expect((await req(app, "GET", `${base}/seating.csv`, OWNER)).status).toBe(200);
    expect((await req(app, "GET", `${base}/seating.csv`, EDITOR)).status).toBe(403);
    expect((await req(app, "GET", `${base}/seating.csv`, VIEWER)).status).toBe(403);
    expect((await req(app, "GET", `${base}/seating.csv`, undefined)).status).toBe(401);
  });
});

describe("seating — tables", () => {
  it("creates tables in order on an event with no stated end, renames, reorders and deletes", async () => {
    const { app } = setup();
    const one = await createTable(app, REC, "  Table 1  ", 8);
    const two = await createTable(app, REC, "Table 2", 10);
    expect(one).toMatchObject({ name: "Table 1", capacity: 8, sortOrder: 0 });
    expect(two).toMatchObject({ name: "Table 2", capacity: 10, sortOrder: 1 });

    const renamed = await req(app, "PATCH", tablePath(one.id), EDITOR, {
      name: "Head table",
      capacity: 12,
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { table: TableDto }).table).toMatchObject({
      name: "Head table",
      capacity: 12,
    });

    const reorder = await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, {
      orderedIds: [two.id, one.id],
    });
    expect(reorder.status).toBe(200);
    const read = await chart(app, REC);
    expect(read.event).toMatchObject({ id: REC, name: "Reception" });
    expect(read.tables.map((t) => t.name)).toEqual(["Table 2", "Head table"]);

    expect((await req(app, "DELETE", tablePath(two.id), EDITOR)).status).toBe(200);
    expect((await chart(app, REC)).tables.map((t) => t.id)).toEqual([one.id]);
  });

  it("refuses a table on another wedding's event or an unknown one, and writes nothing", async () => {
    const { app, db } = setup();
    for (const eventId of [OTHER_EVENT, "evt_nope"]) {
      const res = await req(app, "POST", tablesPath(eventId), EDITOR, { name: "T", capacity: 8 });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe("event_not_found");
      expect((await req(app, "GET", chartPath(eventId), EDITOR)).status).toBe(404);
    }
    expect(db.select().from(seatingTables).all()).toEqual([]);
  });

  it("refuses another wedding's table on every write, and changes nothing there", async () => {
    const { app, db } = setup();
    const theirs = await req(
      app,
      "POST",
      `/api/organiser/weddings/wed_other/seating/events/${OTHER_EVENT}/tables`,
      STRANGER,
      { name: "Theirs", capacity: 8 },
    );
    expect(theirs.status).toBe(200);
    const table = ((await theirs.json()) as { table: TableDto }).table;

    const patch = await req(app, "PATCH", tablePath(table.id), EDITOR, { name: "Mine now" });
    expect(patch.status).toBe(404);
    expect(await errorOf(patch)).toBe("table_not_found");
    const del = await req(app, "DELETE", tablePath(table.id), EDITOR);
    expect(del.status).toBe(404);
    const seat = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: table.id });
    expect(seat.status).toBe(404);
    expect(await errorOf(seat)).toBe("table_not_found");
    const reorder = await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, {
      orderedIds: [table.id],
    });
    expect(reorder.status).toBe(200);

    expect(
      db.select().from(seatingTables).where(eq(seatingTables.id, table.id)).get(),
    ).toMatchObject({ name: "Theirs", sortOrder: 0, weddingId: "wed_other" });
    expect(seatsOf(db, REC)).toEqual([]);
  });

  it("does not reorder a table of another event of the same wedding", async () => {
    const { app } = setup();
    const rec = await createTable(app, REC, "Rec 1");
    const cerA = await createTable(app, CER, "Cer A");
    const cerB = await createTable(app, CER, "Cer B");
    await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, {
      orderedIds: [cerB.id, cerA.id, rec.id],
    });
    expect((await chart(app, CER)).tables.map((t) => t.name)).toEqual(["Cer A", "Cer B"]);
  });

  it("refuses a hundred and first table on one event", async () => {
    const { app, db } = setup();
    const now = new Date();
    db.insert(seatingTables)
      .values(
        Array.from({ length: 100 }, (_, i) => ({
          id: `stb_fill_${i}`,
          weddingId: W,
          eventId: REC,
          name: `T${i}`,
          capacity: 8,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    const res = await req(app, "POST", tablesPath(REC), EDITOR, { name: "One more", capacity: 8 });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("table_limit");
    // The cap is per event: the ceremony still takes one.
    await createTable(app, CER, "Ceremony table");
  });

  it("refuses a capacity below the guests already seated, and keeps the old one", async () => {
    const { app, db } = setup();
    const table = await createTable(app, REC, "Table 1", 4);
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: table.id });
    await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: table.id });
    const res = await req(app, "PATCH", tablePath(table.id), EDITOR, { capacity: 1 });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("capacity_below_seated");
    expect(
      db.select().from(seatingTables).where(eq(seatingTables.id, table.id)).get()?.capacity,
    ).toBe(4);
    // Exactly the seated count is allowed.
    expect((await req(app, "PATCH", tablePath(table.id), EDITOR, { capacity: 2 })).status).toBe(
      200,
    );
  });

  it("unseats a deleted table's guests and leaves the other tables alone", async () => {
    const { app, db } = setup();
    const one = await createTable(app, REC, "Table 1");
    const two = await createTable(app, REC, "Table 2");
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: two.id });
    expect((await req(app, "DELETE", tablePath(one.id), EDITOR)).status).toBe(200);
    expect(seatsOf(db, REC)).toEqual([{ tableId: two.id, guestId: "g_bo" }]);
    const read = await chart(app, REC);
    expect(read.guests.find((g) => g.id === "g_ada")?.tableId).toBeNull();
  });

  it("refuses malformed table bodies", async () => {
    const { app, db } = setup();
    for (const body of [
      {},
      { name: "", capacity: 8 },
      { name: "   ", capacity: 8 },
      { name: "T", capacity: 0 },
      { name: "T", capacity: 101 },
      { name: "T", capacity: 2.5 },
      { name: "x".repeat(81), capacity: 8 },
      "{not json",
    ]) {
      const res = await req(app, "POST", tablesPath(REC), EDITOR, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(db.select().from(seatingTables).all()).toEqual([]);
    const table = await createTable(app, REC, "Table 1");
    for (const body of [{ capacity: 0 }, { name: "" }, { capacity: "8" }]) {
      const res = await req(app, "PATCH", tablePath(table.id), EDITOR, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    for (const body of [{ tableId: 3 }, {}, "{"]) {
      const res = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    const named = await req(app, "POST", tablesPath(REC), EDITOR, { name: "" });
    expect(await jsonBody(named)).toEqual({ error: "Missing or invalid fields" });
  });

  it("refuses an id with anything but word characters and hyphens, before it reaches a JSON path", async () => {
    const { app, db } = setup();
    const one = await createTable(app, REC, "Table 1");
    const two = await createTable(app, REC, "Table 2");
    // Each id has a valid run at one end, so a pattern anchored at only one
    // end would take it.
    for (const id of ["x y", 'stb"x', "$.x", `${one.id}"`]) {
      const seat = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: id });
      const reorder = await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, {
        orderedIds: [two.id, id],
      });
      expect({ id, seat: seat.status, reorder: reorder.status }).toEqual({
        id,
        seat: 400,
        reorder: 400,
      });
    }
    expect(seatsOf(db, REC)).toEqual([]);
    expect((await chart(app, REC)).tables.map((t) => t.id)).toEqual([one.id, two.id]);
  });
});

describe("seating — limits and other weddings", () => {
  const theirBase = "/api/organiser/weddings/wed_other";

  it("takes a name and a capacity at their limits, and refuses one past them", async () => {
    const { app } = setup();
    const at = await req(app, "POST", tablesPath(REC), EDITOR, {
      name: "x".repeat(80),
      capacity: 100,
    });
    expect(at.status).toBe(200);
    const table = ((await at.json()) as { table: TableDto }).table;
    const ids = Array.from({ length: 101 }, (_, i) => `stb_${i}`);
    expect(
      (await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, { orderedIds: ids })).status,
    ).toBe(400);
    expect(
      (await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, { orderedIds: ids.slice(1) }))
        .status,
    ).toBe(200);
    expect(
      (await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, { orderedIds: table.id }))
        .status,
    ).toBe(400);
    for (const tableId of ["", "x".repeat(65)]) {
      const res = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId });
      expect({ tableId, status: res.status }).toEqual({ tableId, status: 400 });
    }
  });

  it("re-orders no other wedding's tables through its event, and reads none on an empty patch", async () => {
    const { app, db } = setup();
    const make = async (name: string) =>
      (
        (await (
          await req(app, "POST", `${theirBase}/seating/events/${OTHER_EVENT}/tables`, STRANGER, {
            name,
            capacity: 8,
          })
        ).json()) as { table: TableDto }
      ).table;
    const first = await make("Theirs 1");
    const second = await make("Theirs 2");
    const reorder = await req(
      app,
      "PATCH",
      `${base}/seating/events/${OTHER_EVENT}/tables/reorder`,
      EDITOR,
      {
        orderedIds: [second.id, first.id],
      },
    );
    expect(reorder.status).toBe(200);
    const order = db
      .select({ id: seatingTables.id, sortOrder: seatingTables.sortOrder })
      .from(seatingTables)
      .where(eq(seatingTables.weddingId, "wed_other"))
      .all();
    expect(order.toSorted((a, b) => a.sortOrder - b.sortOrder).map((t) => t.id)).toEqual([
      first.id,
      second.id,
    ]);

    const theirs = await req(app, "PATCH", tablePath(first.id), EDITOR, {});
    expect(theirs.status).toBe(404);
    expect(await errorOf(theirs)).toBe("table_not_found");
    const mine = await createTable(app, REC, "Mine", 6);
    db.update(seatingTables)
      .set({ updatedAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(seatingTables.id, mine.id))
      .run();
    const written = db.select().from(seatingTables).where(eq(seatingTables.id, mine.id)).get();
    const empty = await req(app, "PATCH", tablePath(mine.id), EDITOR, {});
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { table: TableDto }).table).toEqual(mine);
    // An empty patch reads the table back and writes nothing, not even the time.
    expect(db.select().from(seatingTables).where(eq(seatingTables.id, mine.id)).get()).toEqual(
      written,
    );
  });
});

describe("seating — seats", () => {
  it("seats, moves and unseats a guest, holding one seat per guest per event", async () => {
    const { app, db } = setup();
    const one = await createTable(app, REC, "Table 1");
    const two = await createTable(app, REC, "Table 2");

    const seat = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    expect(seat.status).toBe(200);
    expect(await jsonBody(seat)).toEqual({ guestId: "g_ada", tableId: one.id });
    const move = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: two.id });
    expect(await jsonBody(move)).toEqual({ guestId: "g_ada", tableId: two.id });
    expect(seatsOf(db, REC)).toEqual([{ tableId: two.id, guestId: "g_ada" }]);

    // The same guest may sit at the ceremony too: one seat per EVENT.
    const cer = await createTable(app, CER, "Ceremony row");
    await req(app, "PUT", seatPath(CER, "g_ada"), EDITOR, { tableId: cer.id });
    expect(seatsOf(db, CER)).toEqual([{ tableId: cer.id, guestId: "g_ada" }]);

    const unseat = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: null });
    expect(await jsonBody(unseat)).toEqual({ guestId: "g_ada", tableId: null });
    expect(seatsOf(db, REC)).toEqual([]);
    // Unseating again changes nothing and says so the same way.
    const again = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: null });
    expect(await jsonBody(again)).toEqual({ guestId: "g_ada", tableId: null });
  });

  it("counts each seat, move and unseat once, a refusal by its reason, and a no-op not at all", async () => {
    const { app } = setup();
    const one = await createTable(app, REC, "Table 1", 1);
    const two = await createTable(app, REC, "Table 2");
    const count = async () => ({
      seat: await counterValue(CIRE_METRICS.seatingSeatWrite, { action: "seat" }),
      move: await counterValue(CIRE_METRICS.seatingSeatWrite, { action: "move" }),
      unseat: await counterValue(CIRE_METRICS.seatingSeatWrite, { action: "unseat" }),
      full: await counterValue(CIRE_METRICS.seatingWriteRefused, { reason: "table_full" }),
    });
    const before = await count();
    const delta = async () => {
      const now = await count();
      return {
        seat: now.seat - before.seat,
        move: now.move - before.move,
        unseat: now.unseat - before.unseat,
        full: now.full - before.full,
      };
    };
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    expect(await delta()).toEqual({ seat: 1, move: 0, unseat: 0, full: 0 });
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    expect(await delta()).toEqual({ seat: 1, move: 0, unseat: 0, full: 0 });
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: two.id });
    expect(await delta()).toEqual({ seat: 1, move: 1, unseat: 0, full: 0 });
    await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: one.id });
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    expect(await delta()).toEqual({ seat: 2, move: 1, unseat: 0, full: 1 });
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: null });
    expect(await delta()).toEqual({ seat: 2, move: 1, unseat: 1, full: 1 });
    // Unseating a guest with no seat is a no-op, and counts as one.
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: null });
    expect(await delta()).toEqual({ seat: 2, move: 1, unseat: 1, full: 1 });
  });

  it("counts each table write by action and each refusal by its reason", async () => {
    const { app, db } = setup();
    const table = (action: string) => counterValue(CIRE_METRICS.seatingTableWrite, { action });
    const refused = (reason: string) => counterValue(CIRE_METRICS.seatingWriteRefused, { reason });
    const count = async () => ({
      create: await table("create"),
      update: await table("update"),
      remove: await table("remove"),
      reorder: await table("reorder"),
      limit: await refused("table_limit"),
      below: await refused("capacity_below_seated"),
      withdrawn: await refused("household_withdrawn"),
    });
    const before = await count();
    const delta = async () => {
      const now = await count();
      return Object.fromEntries(
        Object.entries(now).map(([k, v]) => [k, v - before[k as keyof typeof before]]),
      );
    };
    const one = await createTable(app, REC, "Table 1", 2);
    const two = await createTable(app, REC, "Table 2");
    await req(app, "PATCH", tablePath(one.id), EDITOR, { name: "Head table" });
    await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, { orderedIds: [two.id, one.id] });
    // An empty reorder writes nothing, and counts nothing.
    const empty = await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, { orderedIds: [] });
    expect(empty.status).toBe(200);
    await req(app, "DELETE", tablePath(two.id), EDITOR);
    expect(await delta()).toMatchObject({ create: 2, update: 1, remove: 1, reorder: 1 });

    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: one.id });
    await req(app, "PATCH", tablePath(one.id), EDITOR, { capacity: 1 });
    await req(app, "PUT", seatPath(REC, "g_gone"), EDITOR, { tableId: one.id });
    const now = new Date();
    db.insert(seatingTables)
      .values(
        Array.from({ length: 99 }, (_, i) => ({
          id: `stb_fill_${i}`,
          weddingId: W,
          eventId: REC,
          name: `T${i}`,
          capacity: 8,
          sortOrder: i + 1,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    await req(app, "POST", tablesPath(REC), EDITOR, { name: "One more", capacity: 8 });
    expect(await delta()).toEqual({
      create: 2,
      update: 1,
      remove: 1,
      reorder: 1,
      limit: 1,
      below: 1,
      withdrawn: 1,
    });
  });

  it("is refused by the database itself when a second seat is written for the same guest and event", async () => {
    const { app, db } = setup();
    const one = await createTable(app, REC, "Table 1");
    const two = await createTable(app, REC, "Table 2");
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    expect(() =>
      db
        .insert(seatingAssignments)
        .values({ tableId: two.id, eventId: REC, guestId: "g_ada", createdAt: new Date() })
        .run(),
    ).toThrow(
      /UNIQUE constraint failed: seating_assignments\.event_id, seating_assignments\.guest_id/,
    );
    // A seat claiming one event while its table sits at another is refused too.
    const cer = await createTable(app, CER, "Ceremony row");
    expect(() =>
      db
        .insert(seatingAssignments)
        .values({ tableId: cer.id, eventId: REC, guestId: "g_bo", createdAt: new Date() })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    // So is a guest the event does not invite.
    expect(() =>
      db
        .insert(seatingAssignments)
        .values({ tableId: one.id, eventId: REC, guestId: "g_cy", createdAt: new Date() })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("refuses a full table and keeps the moving guest's old seat", async () => {
    const { app, db } = setup();
    const small = await createTable(app, REC, "Small", 1);
    const big = await createTable(app, REC, "Big", 8);
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: small.id });
    await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: big.id });

    const res = await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: small.id });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("table_full");
    expect(seatsOf(db, REC)).toEqual([
      { tableId: small.id, guestId: "g_ada" },
      { tableId: big.id, guestId: "g_bo" },
    ]);
    // Seating a guest where they already sit is not a second seat at a full table.
    const same = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: small.id });
    expect(await jsonBody(same)).toEqual({ guestId: "g_ada", tableId: small.id });
  });

  it("refuses guests the chart does not hold, and writes nothing", async () => {
    const { app, db } = setup();
    const table = await createTable(app, REC, "Table 1");
    for (const guestId of ["g_xeno", "g_cy", "g_host", "g_nope"]) {
      const res = await req(app, "PUT", seatPath(REC, guestId), EDITOR, { tableId: table.id });
      expect({ guestId, status: res.status }).toEqual({ guestId, status: 404 });
      expect(await errorOf(res)).toBe("guest_not_found");
    }
    const withdrawn = await req(app, "PUT", seatPath(REC, "g_gone"), EDITOR, {
      tableId: table.id,
    });
    expect(withdrawn.status).toBe(409);
    expect(await errorOf(withdrawn)).toBe("household_withdrawn");
    expect(seatsOf(db, REC)).toEqual([]);

    // A table of another event of this wedding is not this event's table.
    const cer = await createTable(app, CER, "Ceremony row");
    const wrongEvent = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: cer.id });
    expect(wrongEvent.status).toBe(404);
    expect(await errorOf(wrongEvent)).toBe("table_not_found");
    // And another wedding's event is not this wedding's.
    const otherEvent = await req(app, "PUT", seatPath(OTHER_EVENT, "g_xeno"), EDITOR, {
      tableId: null,
    });
    expect(otherEvent.status).toBe(404);
    expect(await errorOf(otherEvent)).toBe("event_not_found");
  });

  it("lets a withdrawn household's seated guest be unseated, but not moved", async () => {
    const { app, db } = setup();
    const one = await createTable(app, REC, "Table 1");
    const two = await createTable(app, REC, "Table 2");
    // Seated while the invitation stood, then withdrawn.
    db.update(families).set({ deactivatedAt: null }).where(eq(families.id, "fam_gone")).run();
    await req(app, "PUT", seatPath(REC, "g_gone"), EDITOR, { tableId: one.id });
    db.update(families).set({ deactivatedAt: new Date() }).where(eq(families.id, "fam_gone")).run();

    const move = await req(app, "PUT", seatPath(REC, "g_gone"), EDITOR, { tableId: two.id });
    expect(move.status).toBe(409);
    expect(await errorOf(move)).toBe("household_withdrawn");
    expect(seatsOf(db, REC)).toEqual([{ tableId: one.id, guestId: "g_gone" }]);
    const unseat = await req(app, "PUT", seatPath(REC, "g_gone"), EDITOR, { tableId: null });
    expect(unseat.status).toBe(200);
    expect(seatsOf(db, REC)).toEqual([]);
  });

  it("takes the seat away with the invitation and with the guest", async () => {
    const { app, db } = setup();
    const table = await createTable(app, REC, "Table 1");
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: table.id });
    await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: table.id });
    db.delete(guestEvents)
      .where(and(eq(guestEvents.guestId, "g_ada"), eq(guestEvents.eventId, REC)))
      .run();
    expect(seatsOf(db, REC)).toEqual([{ tableId: table.id, guestId: "g_bo" }]);
    db.delete(guests).where(eq(guests.id, "g_bo")).run();
    expect(seatsOf(db, REC)).toEqual([]);
  });
});

describe("seating — the chart", () => {
  it("shows the event's invited guests with their reply, and never the host-preview household", async () => {
    const { app } = setup();
    const read = await chart(app, REC);
    expect(read.guests.map((g) => [g.id, g.rsvp, g.withdrawn, g.tableId])).toEqual([
      ["g_ada", "attending", false, null],
      ["g_bo", "declined", false, null],
    ]);
    // What the screen shows, and nothing it does not.
    expect(Object.keys(read.guests[0]!).toSorted()).toEqual([
      "firstName",
      "id",
      "lastName",
      "rsvp",
      "tableId",
      "withdrawn",
    ]);
    expect(read.event).toEqual({ id: REC, name: "Reception" });
    expect((await chart(app, CER)).guests.map((g) => [g.id, g.rsvp])).toEqual([
      ["g_ada", null],
      ["g_cy", null],
    ]);
    const res = await req(app, "GET", chartPath(REC), EDITOR);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("shows a withdrawn household's guest only while still seated", async () => {
    const { app, db } = setup();
    const table = await createTable(app, REC, "Table 1");
    db.update(families).set({ deactivatedAt: null }).where(eq(families.id, "fam_gone")).run();
    await req(app, "PUT", seatPath(REC, "g_gone"), EDITOR, { tableId: table.id });
    db.update(families).set({ deactivatedAt: new Date() }).where(eq(families.id, "fam_gone")).run();
    const seated = (await chart(app, REC)).guests.find((g) => g.id === "g_gone");
    expect(seated).toMatchObject({ withdrawn: true, tableId: table.id });
    await req(app, "PUT", seatPath(REC, "g_gone"), EDITOR, { tableId: null });
    expect((await chart(app, REC)).guests.some((g) => g.id === "g_gone")).toBe(false);
  });
});

describe("seating — the venue file", () => {
  it("prints every seated guest by event and table order, and nobody unseated", async () => {
    const { app, db } = setup();
    const two = await createTable(app, REC, "Table 2", 10);
    const one = await createTable(app, REC, "Table 1", 8);
    await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, { orderedIds: [one.id, two.id] });
    const cer = await createTable(app, CER, "Front row", 4);
    await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: one.id });
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: two.id });
    await req(app, "PUT", seatPath(CER, "g_cy"), EDITOR, { tableId: cer.id });
    // Withdrawn after being seated: printed, and said so.
    db.update(families).set({ deactivatedAt: null }).where(eq(families.id, "fam_gone")).run();
    await req(app, "PUT", seatPath(REC, "g_gone"), EDITOR, { tableId: one.id });
    db.update(families).set({ deactivatedAt: new Date() }).where(eq(families.id, "fam_gone")).run();
    // A "maybe" prints as Maybe.
    db.insert(rsvps)
      .values({
        id: "rsvp_cy",
        guestId: "g_cy",
        eventId: CER,
        status: "maybe",
        createdAt: new Date(),
      })
      .run();
    // The host-preview household can never be seated through the API; one
    // that exists in the database is still left off the venue's list.
    db.insert(seatingAssignments)
      .values({ tableId: cer.id, eventId: CER, guestId: "g_host", createdAt: new Date() })
      .run();
    // Another wedding's seat is never in this wedding's file.
    const theirTable = (
      (await (
        await req(
          app,
          "POST",
          `/api/organiser/weddings/wed_other/seating/events/${OTHER_EVENT}/tables`,
          STRANGER,
          {
            name: "Their table",
            capacity: 8,
          },
        )
      ).json()) as { table: TableDto }
    ).table;
    await req(
      app,
      "PUT",
      `/api/organiser/weddings/wed_other/seating/events/${OTHER_EVENT}/guests/g_xeno`,
      STRANGER,
      {
        tableId: theirTable.id,
      },
    );

    const res = await req(app, "GET", `${base}/seating.csv`, OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("cire-seating-");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await res.text()).split("\r\n")).toEqual([
      "Event,Table,Capacity,Guest,Household,RSVP",
      "Ceremony,Front row,4,Cy,Charlie,Maybe",
      "Reception,Table 1,8,Bo,Alpha,Declined",
      "Reception,Table 1,8,Gwen,Gone,Invite withdrawn",
      "Reception,Table 2,10,Ada,Alpha,Attending",
    ]);
    const theirs = await req(app, "GET", "/api/organiser/weddings/wed_other/seating.csv", STRANGER);
    expect((await theirs.text()).split("\r\n")).toEqual([
      "Event,Table,Capacity,Guest,Household,RSVP",
      "Other reception,Their table,8,Xeno,Xeno,No reply",
    ]);
  });

  it("is a header alone for a wedding with no seats", async () => {
    const { app } = setup();
    const res = await req(app, "GET", `${base}/seating.csv`, OWNER);
    expect(await res.text()).toBe("Event,Table,Capacity,Guest,Household,RSVP");
  });

  it("counts the seats the file would print, for the locked Seating card", async () => {
    const { app, db } = setup();
    const empty = await req(app, "GET", `${base}/module-rows`, OWNER);
    expect(await jsonBody(empty)).toMatchObject({ seats: 0 });
    const rec = await createTable(app, REC, "Table 1");
    const cer = await createTable(app, CER, "Front row");
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: rec.id });
    await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: rec.id });
    await req(app, "PUT", seatPath(CER, "g_ada"), EDITOR, { tableId: cer.id });
    // Another wedding's seat is not this wedding's.
    const theirs = await req(
      app,
      "POST",
      `/api/organiser/weddings/wed_other/seating/events/${OTHER_EVENT}/tables`,
      STRANGER,
      { name: "Theirs", capacity: 8 },
    );
    const theirTable = ((await theirs.json()) as { table: TableDto }).table;
    await req(
      app,
      "PUT",
      `/api/organiser/weddings/wed_other/seating/events/${OTHER_EVENT}/guests/g_xeno`,
      STRANGER,
      { tableId: theirTable.id },
    );
    // Moved below the module's tier: the count, like the file, is still served.
    setTier(db, W, "ivory");
    const counts = await req(app, "GET", `${base}/module-rows`, OWNER);
    expect(await jsonBody(counts)).toMatchObject({ seats: 3 });
  });
});

describe("seating — what each answer says, and what a failure hides", () => {
  it("answers a reorder and a delete with ok, and names what it could not find", async () => {
    const { app } = setup();
    const one = await createTable(app, REC, "Table 1");
    const two = await createTable(app, REC, "Table 2");
    const reorder = await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, {
      orderedIds: [two.id, one.id],
    });
    expect(await jsonBody(reorder)).toEqual({ ok: true });
    expect(await jsonBody(await req(app, "DELETE", tablePath(two.id), EDITOR))).toEqual({
      ok: true,
    });
    const gone = await req(app, "DELETE", tablePath(two.id), EDITOR);
    expect(gone.status).toBe(404);
    expect(await errorOf(gone)).toBe("table_not_found");

    const theirChart = await req(app, "GET", chartPath(OTHER_EVENT), EDITOR);
    expect(theirChart.status).toBe(404);
    expect(await errorOf(theirChart)).toBe("event_not_found");
    // Seating at another wedding's event names the event, not this
    // wedding's table that was sent with it.
    const theirSeat = await req(app, "PUT", seatPath(OTHER_EVENT, "g_xeno"), EDITOR, {
      tableId: one.id,
    });
    expect(theirSeat.status).toBe(404);
    expect(await errorOf(theirSeat)).toBe("event_not_found");
  });

  it("names the venue file after the wedding", async () => {
    const { app } = setup();
    const res = await req(app, "GET", `${base}/seating.csv`, OWNER);
    expect(res.headers.get("content-disposition")).toContain("cire-seating-cire-wedding.csv");
  });

  it("answers a failed read or write with a plain 500, and logs the step but no name", async () => {
    const { app, db } = setup();
    const table = await createTable(app, REC, "Secret table");
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: table.id });
    // Every D1 error reaches a handler as a defect; dropping the chart's
    // tables is the cheapest way to raise one on every route.
    db.$client.exec("DROP TABLE seating_assignments; DROP TABLE seating_tables;");
    const calls: Array<[string, string, string, unknown]> = [
      ["chart", "GET", chartPath(REC), undefined],
      ["createTable", "POST", tablesPath(REC), { name: "Secret table", capacity: 8 }],
      ["reorderTables", "PATCH", `${tablesPath(REC)}/reorder`, { orderedIds: [table.id] }],
      ["updateTable", "PATCH", tablePath(table.id), { name: "Secret table" }],
      ["removeTable", "DELETE", tablePath(table.id), undefined],
      ["seat", "PUT", seatPath(REC, "g_ada"), { tableId: table.id }],
    ];
    for (const [operation, method, path, body] of calls) {
      let res: Response | undefined;
      const logs = await captureLogs(async () => {
        res = await req(app, method, path, EDITOR, body);
      });
      expect({ operation, status: res?.status, body: await res?.json() }).toEqual({
        operation,
        status: 500,
        body: { error: "Internal error" },
      });
      expect(logs).toContain("seating request failed");
      expect(logs).toContain(`"operation":"${operation}"`);
      expect(logs).not.toContain("Secret table");
      expect(logs).not.toContain("Ada");
    }
    const file = await req(app, "GET", `${base}/seating.csv`, OWNER);
    expect(file.status).toBe(500);
    expect(await jsonBody(file)).toEqual({ error: "Internal error" });
  });
});
