import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guestEvents,
  guests,
  rsvps,
  seatingAssignments,
  seatingCopyBudget,
  seatingPlans,
  seatingTables,
  weddingHosts,
} from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { and, count as sqlCount, eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { createApp } from "../../src/app";
import { effectDbFor } from "../../src/db/effect-handle";
import { localD1Binding } from "../../src/db/local-d1";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import {
  MAX_COPIED_ROWS_PER_DAY,
  MAX_PLANS_PER_EVENT,
  MAX_TABLES_PER_PLAN,
} from "../../src/schemas/seating";
import { appRequest, jsonBody, refusal, setTier } from "../test-helpers";
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
/** An event of this wedding with no seating plan yet. */
const PARTY = "evt_party";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/**
 * One wedding with three events — the reception has no stated end (`""`) — and
 * four households: Alpha (Ada, Bo), the host-preview household, a withdrawn
 * household (Gwen) and Charlie (Cy, invited to the ceremony only). The
 * reception and the ceremony each have one selected plan (`PLAN`); the after
 * party, which invites Ada and Bo, has none. A second wedding owned by a
 * stranger has its own event, plan, household and guest.
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
      {
        id: PARTY,
        weddingId: W,
        slug: "after-party",
        name: "After party",
        startAt: "2027-03-01T23:00",
        endAt: "",
        timezone: "Australia/Sydney",
        sortOrder: 2,
      },
    ])
    .run();
  // Every event but the after party has its one plan, selected, as the API
  // makes it with the event's first table.
  db.insert(seatingPlans)
    .values(
      [
        [REC, W],
        [CER, W],
        [OTHER_EVENT, "wed_other"],
      ].map(([eventId, weddingId]) => ({
        id: PLAN[eventId!]!,
        weddingId: weddingId!,
        eventId: eventId!,
        name: "Plan 1",
        selected: true,
        createdAt: now,
        updatedAt: now,
      })),
    )
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
      { guestId: "g_ada", eventId: PARTY },
      { guestId: "g_bo", eventId: PARTY },
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

/** A fresh app on a fresh database; each app has its own plan-write budget,
 *  as the Worker's isolates do, at the Worker's size unless one is given. The
 *  export limiter is the app's own too, and wide, so the venue-file reads here
 *  spend no other test file's budget; its limit is tested in
 *  `organiser-weddings.test.ts`. */
function setup(
  tier: "ivory" | "gold" | "crimson" = "gold",
  seatingPlanLimiter = createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
) {
  const db = buildDb(tier);
  const exportLimiter = createRateLimiter({ maxRequests: 1_000, windowMs: 60_000 });
  return {
    db,
    app: createApp(db, {
      osnTestKey: auth.key,
      seatingPlanLimiter,
      exportLimiter,
      effectDb: effectDbFor(localD1Binding(db.$client), "fetch"),
    }),
  };
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
const theirBase = "/api/organiser/weddings/wed_other";
/** Each event's selected plan, as `buildDb` writes it; any other event's is a
 *  plan nobody has. */
const PLAN: Record<string, string> = {
  [REC]: "spl_rec",
  [CER]: "spl_cer",
  [OTHER_EVENT]: "spl_other",
};
const planOf = (eventId: string) => PLAN[eventId] ?? `spl_none_${eventId}`;
const chartPath = (eventId: string, planId?: string) =>
  `${base}/seating/events/${eventId}${planId ? `?plan=${planId}` : ""}`;
const plansPath = (eventId: string) => `${base}/seating/events/${eventId}/plans`;
const planPath = (planId: string) => `${base}/seating/plans/${planId}`;
const selectPath = (eventId: string) => `${base}/seating/events/${eventId}/selected-plan`;
/** The tables of an event's selected plan. */
const tablesPath = (eventId: string) => `${base}/seating/plans/${planOf(eventId)}/tables`;
const tablePath = (tableId: string) => `${base}/seating/tables/${tableId}`;
/** A guest's seat in an event's selected plan. */
const seatPath = (eventId: string, guestId: string) =>
  `${base}/seating/plans/${planOf(eventId)}/guests/${guestId}`;

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
interface PlanDto {
  id: string;
  name: string;
  selected: boolean;
}
interface ChartDto {
  event: { id: string; name: string };
  plans: PlanDto[];
  planId: string | null;
  tables: TableDto[];
  guests: GuestDto[];
}

/** A table in the event's selected plan, or in `planId`. */
async function createTable(
  app: App,
  eventId: string,
  name: string,
  capacity = 8,
  planId = planOf(eventId),
) {
  const res = await req(app, "POST", `${planPath(planId)}/tables`, EDITOR, { name, capacity });
  expect(res.status).toBe(200);
  return ((await res.json()) as { table: TableDto }).table;
}

async function chart(app: App, eventId: string, as = EDITOR, planId?: string): Promise<ChartDto> {
  const res = await req(app, "GET", chartPath(eventId, planId), as);
  expect(res.status).toBe(200);
  return (await res.json()) as ChartDto;
}

/** A new plan at the event: blank, or a copy of `copyFrom`. */
async function createPlan(app: App, eventId: string, name: string, copyFrom?: string) {
  const res = await req(app, "POST", plansPath(eventId), EDITOR, { name, copyFrom });
  expect(res.status).toBe(200);
  return ((await res.json()) as { plan: PlanDto }).plan;
}

/** Every plan's tables and seats at an event, by plan, as the database holds
 *  them: table names in order, and each guest with their table's name. */
function plansIn(db: TestDb, eventId: string) {
  const plans = db
    .select()
    .from(seatingPlans)
    .where(eq(seatingPlans.eventId, eventId))
    .all()
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return plans.map((plan) => {
    const tables = db
      .select()
      .from(seatingTables)
      .where(eq(seatingTables.planId, plan.id))
      .all()
      .toSorted((a, b) => a.sortOrder - b.sortOrder);
    const names = new Map(tables.map((t) => [t.id, t.name]));
    const seats = db
      .select()
      .from(seatingAssignments)
      .where(eq(seatingAssignments.planId, plan.id))
      .all()
      .map((s) => `${s.guestId}@${names.get(s.tableId) ?? "?"}`)
      .toSorted();
    return {
      id: plan.id,
      name: plan.name,
      selected: plan.selected,
      tables: tables.map((t) => `${t.name}/${t.capacity}`),
      seats,
    };
  });
}

/** The stranger's wedding seats its one guest at "Their table". */
async function seatTheirGuest(app: App) {
  const created = await req(
    app,
    "POST",
    `${theirBase}/seating/plans/${PLAN[OTHER_EVENT]}/tables`,
    STRANGER,
    { name: "Their table", capacity: 8 },
  );
  const table = ((await created.json()) as { table: TableDto }).table;
  const seated = await req(
    app,
    "PUT",
    `${theirBase}/seating/plans/${PLAN[OTHER_EVENT]}/guests/g_xeno`,
    STRANGER,
    { tableId: table.id },
  );
  expect(seated.status).toBe(200);
  return table;
}

/** How many rows a table holds. */
const rowsIn = (db: TestDb, table: SQLiteTable) =>
  db.select({ n: sqlCount() }).from(table).get()?.n ?? 0;

/** Each plan's seats at an event, keyed by plan id. */
const seatsByPlan = (db: TestDb, eventId: string) =>
  Object.fromEntries(plansIn(db, eventId).map((plan) => [plan.id, plan.seats]));

const seatsOf = (db: TestDb, eventId: string) =>
  db
    .select({ tableId: seatingAssignments.tableId, guestId: seatingAssignments.guestId })
    .from(seatingAssignments)
    .where(eq(seatingAssignments.eventId, eventId))
    .all()
    .toSorted((a, b) => a.guestId.localeCompare(b.guestId));

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("seating — who may read and write", () => {
  it("answers 401 without a token, on reads, writes and the plan writes", async () => {
    const { app, db } = setup();
    expect((await req(app, "GET", chartPath(REC), undefined)).status).toBe(401);
    expect(
      (await req(app, "POST", tablesPath(REC), undefined, { name: "T", capacity: 8 })).status,
    ).toBe(401);
    expect(
      (await req(app, "POST", plansPath(REC), undefined, { name: "P", copyFrom: PLAN[REC] }))
        .status,
    ).toBe(401);
    expect((await req(app, "DELETE", planPath(PLAN[REC]!), undefined)).status).toBe(401);
    expect(rowsIn(db, seatingPlans)).toBe(3);
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

    // The plan writes sit on an instance of their own, with their own gate.
    const plansBefore = rowsIn(db, seatingPlans);
    expect(
      (await withCookie(dead, "POST", plansPath(REC), { name: "Dead", copyFrom: PLAN[REC] }))
        .status,
    ).toBe(401);
    expect((await withCookie(dead, "DELETE", planPath(PLAN[REC]!))).status).toBe(401);
    const badBearerPlan = await appRequest(app, plansPath(REC), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-jwt" },
      body: JSON.stringify({ name: "Bad" }),
    });
    expect(badBearerPlan.status).toBe(401);
    expect(rowsIn(db, seatingPlans)).toBe(plansBefore);
    const byCookie = await withCookie(`cire_org_session=${token}`, "POST", plansPath(REC), {
      name: "By cookie",
    });
    expect(byCookie.status).toBe(200);
    const made = ((await byCookie.json()) as { plan: PlanDto }).plan;
    expect(
      (await withCookie(`cire_org_session=${token}`, "DELETE", planPath(made.id))).status,
    ).toBe(200);
  });

  it("refuses a member of another wedding, reading or writing", async () => {
    const { app, db } = setup();
    expect((await req(app, "GET", chartPath(REC), STRANGER)).status).toBe(403);
    const res = await req(app, "POST", tablesPath(REC), STRANGER, { name: "T", capacity: 8 });
    expect(res.status).toBe(403);
    for (const [method, path, body] of [
      ["POST", plansPath(REC), { name: "P", copyFrom: PLAN[REC] }],
      ["DELETE", planPath(PLAN[REC]!), undefined],
    ] as const) {
      const plan = await req(app, method, path, STRANGER, body);
      expect({ path, status: plan.status }).toEqual({ path, status: 403 });
    }
    expect(rowsIn(db, seatingPlans)).toBe(3);
  });

  it("refuses a helper seat, reading or writing", async () => {
    const { app } = setup();
    const read = await req(app, "GET", chartPath(REC), HELPER);
    expect(read.status).toBe(403);
    expect(await errorOf(read)).toBe("forbidden");
    for (const [method, path, body] of [
      ["POST", tablesPath(REC), { name: "T", capacity: 8 }],
      ["POST", plansPath(REC), { name: "P" }],
      ["DELETE", planPath(PLAN[REC]!), undefined],
    ] as const) {
      const write = await req(app, method, path, HELPER, body);
      expect({ path, status: write.status, error: await errorOf(write) }).toEqual({
        path,
        status: 403,
        error: "forbidden",
      });
    }
  });

  it("lets a viewer read the chart and its plans but not change them", async () => {
    const { app, db } = setup();
    const table = await createTable(app, REC, "Table 1");
    const alt = await createPlan(app, REC, "Alt");
    const read = await chart(app, REC, VIEWER, alt.id);
    expect(read.planId).toBe(alt.id);
    const before = plansIn(db, REC);
    for (const [method, path, body] of [
      ["POST", tablesPath(REC), { name: "T", capacity: 8 }],
      ["PATCH", tablePath(table.id), { name: "Renamed" }],
      ["DELETE", tablePath(table.id), undefined],
      ["PATCH", `${tablesPath(REC)}/reorder`, { orderedIds: [table.id] }],
      ["PUT", seatPath(REC, "g_ada"), { tableId: table.id }],
      ["POST", plansPath(REC), { name: "Viewer's", copyFrom: PLAN[REC] }],
      ["PATCH", planPath(alt.id), { name: "Renamed" }],
      ["DELETE", planPath(alt.id), undefined],
      ["PUT", selectPath(REC), { planId: alt.id }],
    ] as const) {
      const res = await req(app, method, path, VIEWER, body);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
      expect(await errorOf(res)).toBe("read_only_role");
    }
    expect(plansIn(db, REC)).toEqual(before);
  });

  it("answers 402 naming Gold to a wedding below it, reading and writing", async () => {
    const { app } = setup("ivory");
    for (const [method, path, body] of [
      ["GET", chartPath(REC), undefined],
      ["POST", tablesPath(REC), { name: "T", capacity: 8 }],
      ["PUT", seatPath(REC, "g_ada"), { tableId: null }],
      ["POST", plansPath(REC), { name: "Alt", copyFrom: PLAN[REC] }],
      ["PATCH", planPath(PLAN[REC]!), { name: "Renamed" }],
      ["DELETE", planPath(PLAN[REC]!), undefined],
      ["PUT", selectPath(REC), { planId: PLAN[REC] }],
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

  it("refuses a table in another wedding's plan or an unknown one, and writes nothing", async () => {
    const { app, db } = setup();
    for (const eventId of [OTHER_EVENT, "evt_nope"]) {
      const res = await req(app, "POST", tablesPath(eventId), EDITOR, { name: "T", capacity: 8 });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe("plan_not_found");
      expect((await req(app, "GET", chartPath(eventId), EDITOR)).status).toBe(404);
    }
    expect(db.select().from(seatingTables).all()).toEqual([]);
  });

  it("refuses another wedding's table on every write, and changes nothing there", async () => {
    const { app, db } = setup();
    const theirs = await req(
      app,
      "POST",
      `${theirBase}/seating/plans/${PLAN[OTHER_EVENT]}/tables`,
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

  it("does not reorder a table of another plan, at this event or another", async () => {
    const { app } = setup();
    const rec = await createTable(app, REC, "Rec 1");
    const cerA = await createTable(app, CER, "Cer A");
    const cerB = await createTable(app, CER, "Cer B");
    const alt = await createPlan(app, REC, "Alt");
    const altA = await createTable(app, REC, "Alt A", 8, alt.id);
    const altB = await createTable(app, REC, "Alt B", 8, alt.id);
    await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, {
      orderedIds: [cerB.id, cerA.id, altB.id, altA.id, rec.id],
    });
    expect((await chart(app, CER)).tables.map((t) => t.name)).toEqual(["Cer A", "Cer B"]);
    expect((await chart(app, REC, EDITOR, alt.id)).tables.map((t) => t.name)).toEqual([
      "Alt A",
      "Alt B",
    ]);
  });

  it("refuses a hundred and first table in one plan", async () => {
    const { app, db } = setup();
    const now = new Date();
    db.insert(seatingTables)
      .values(
        Array.from({ length: 100 }, (_, i) => ({
          id: `stb_fill_${i}`,
          weddingId: W,
          eventId: REC,
          planId: PLAN[REC]!,
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
    // The cap is per plan: another plan of the same event, and the ceremony's,
    // still take one.
    const alt = await createPlan(app, REC, "Alt");
    await createTable(app, REC, "Alt table", 8, alt.id);
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

  it("re-orders no other wedding's tables through its plan, and reads none on an empty patch", async () => {
    const { app, db } = setup();
    const make = async (name: string) =>
      (
        (await (
          await req(
            app,
            "POST",
            `${theirBase}/seating/plans/${PLAN[OTHER_EVENT]}/tables`,
            STRANGER,
            {
              name,
              capacity: 8,
            },
          )
        ).json()) as { table: TableDto }
      ).table;
    const first = await make("Theirs 1");
    const second = await make("Theirs 2");
    const reorder = await req(
      app,
      "PATCH",
      `${base}/seating/plans/${PLAN[OTHER_EVENT]}/tables/reorder`,
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
  it("seats, moves and unseats a guest, holding one seat per guest per plan", async () => {
    const { app, db } = setup();
    const one = await createTable(app, REC, "Table 1");
    const two = await createTable(app, REC, "Table 2");

    const seat = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    expect(seat.status).toBe(200);
    expect(await jsonBody(seat)).toEqual({ guestId: "g_ada", tableId: one.id });
    const move = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: two.id });
    expect(await jsonBody(move)).toEqual({ guestId: "g_ada", tableId: two.id });
    expect(seatsOf(db, REC)).toEqual([{ tableId: two.id, guestId: "g_ada" }]);

    // The same guest may sit at the ceremony too: one seat per PLAN, and a
    // plan is one event's.
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
          planId: PLAN[REC]!,
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

  it("is refused by the database itself when a second seat is written for the same guest and plan", async () => {
    const { app, db } = setup();
    const one = await createTable(app, REC, "Table 1");
    const two = await createTable(app, REC, "Table 2");
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    const seat = (tableId: string, planId: string, eventId: string, guestId: string) =>
      db
        .insert(seatingAssignments)
        .values({ tableId, planId, eventId, guestId, createdAt: new Date() })
        .run();
    expect(refusal(() => seat(two.id, PLAN[REC]!, REC, "g_ada"))).toMatch(
      /UNIQUE constraint failed: seating_assignments\.plan_id, seating_assignments\.guest_id/,
    );
    // A seat claiming one event while its table sits at another is refused too.
    const cer = await createTable(app, CER, "Ceremony row");
    expect(refusal(() => seat(cer.id, PLAN[CER]!, REC, "g_bo"))).toMatch(
      /FOREIGN KEY constraint failed/,
    );
    // So is a guest the event does not invite.
    expect(refusal(() => seat(one.id, PLAN[REC]!, REC, "g_cy"))).toMatch(
      /FOREIGN KEY constraint failed/,
    );
    // And a seat claiming a plan its table is not in.
    const alt = await createPlan(app, REC, "Alt");
    const altTable = await createTable(app, REC, "Alt table", 8, alt.id);
    expect(refusal(() => seat(altTable.id, PLAN[REC]!, REC, "g_bo"))).toMatch(
      /FOREIGN KEY constraint failed/,
    );
    // The same guest in a second plan is a second seat the database allows.
    seat(altTable.id, alt.id, REC, "g_ada");
    expect(seatsByPlan(db, REC)).toEqual({
      [PLAN[REC]!]: ["g_ada@Table 1"],
      [alt.id]: ["g_ada@Alt table"],
    });
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

    // A table of another event of this wedding is not this plan's table, and
    // nor is one of another plan of the same event.
    const cer = await createTable(app, CER, "Ceremony row");
    const wrongEvent = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: cer.id });
    expect(wrongEvent.status).toBe(404);
    expect(await errorOf(wrongEvent)).toBe("table_not_found");
    const alt = await createPlan(app, REC, "Alt");
    const altTable = await createTable(app, REC, "Alt table", 8, alt.id);
    const wrongPlan = await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, {
      tableId: altTable.id,
    });
    expect(wrongPlan.status).toBe(404);
    expect(await errorOf(wrongPlan)).toBe("table_not_found");
    // And another wedding's plan is not this wedding's.
    const otherPlan = await req(app, "PUT", seatPath(OTHER_EVENT, "g_xeno"), EDITOR, {
      tableId: null,
    });
    expect(otherPlan.status).toBe(404);
    expect(await errorOf(otherPlan)).toBe("plan_not_found");
    expect(seatsOf(db, REC)).toEqual([]);
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

describe("seating — plans", () => {
  /** The reception's plan with two tables: Ada and Bo at Table 1, Gwen's
   *  household withdrawn after she was seated at Table 2. */
  async function arranged(app: App, db: TestDb) {
    const one = await createTable(app, REC, "Table 1", 4);
    const two = await createTable(app, REC, "Table 2", 6);
    await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: one.id });
    await req(app, "PUT", seatPath(REC, "g_bo"), EDITOR, { tableId: one.id });
    db.update(families).set({ deactivatedAt: null }).where(eq(families.id, "fam_gone")).run();
    await req(app, "PUT", seatPath(REC, "g_gone"), EDITOR, { tableId: two.id });
    db.update(families).set({ deactivatedAt: new Date() }).where(eq(families.id, "fam_gone")).run();
    return { one, two };
  }

  it("starts an event's first plan selected, and every later one not", async () => {
    const { app, db } = setup();
    const first = await createPlan(app, PARTY, "  Plan 1  ");
    expect(first).toMatchObject({ name: "Plan 1", selected: true });
    expect(first.id).toMatch(/^spl_[\w-]+$/);
    const second = await createPlan(app, PARTY, "Plan 2");
    expect(second).toMatchObject({ name: "Plan 2", selected: false });
    expect(
      plansIn(db, PARTY)
        .map((p) => [p.name, p.selected, p.tables.length])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["Plan 1", true, 0],
      ["Plan 2", false, 0],
    ]);
  });

  it("copies a plan's tables, in order, and every seat, under new ids", async () => {
    const { app, db } = setup();
    const { one, two } = await arranged(app, db);
    await req(app, "PATCH", `${tablesPath(REC)}/reorder`, EDITOR, { orderedIds: [two.id, one.id] });
    const copy = await createPlan(app, REC, "Plan 1 copy", PLAN[REC]);
    expect(copy).toMatchObject({ name: "Plan 1 copy", selected: false });
    const byId = Object.fromEntries(plansIn(db, REC).map((p) => [p.id, p]));
    const source = byId[PLAN[REC]!]!;
    const copied = byId[copy.id]!;
    expect(copied.tables).toEqual(source.tables);
    expect(copied.tables).toEqual(["Table 2/6", "Table 1/4"]);
    expect(copied.seats).toEqual(source.seats);
    expect(copied.seats).toEqual(["g_ada@Table 1", "g_bo@Table 1", "g_gone@Table 2"]);
    const copiedIds = db
      .select({ id: seatingTables.id })
      .from(seatingTables)
      .where(eq(seatingTables.planId, copy.id))
      .all()
      .map((t) => t.id);
    expect(copiedIds).toHaveLength(2);
    expect(copiedIds).not.toContain(one.id);
    expect(copiedIds).not.toContain(two.id);
    // The copy reads as its own chart.
    const read = await chart(app, REC, EDITOR, copy.id);
    expect(read.planId).toBe(copy.id);
    expect(read.tables.map((t) => t.name)).toEqual(["Table 2", "Table 1"]);
    expect(read.guests.find((g) => g.id === "g_ada")?.tableId).toBe(
      read.tables.find((t) => t.name === "Table 1")?.id,
    );
  });

  it("copies tables that tie on their place in the order the source shows them", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    await createTable(app, REC, "Table 3", 2);
    // Every table at one place: the source orders them by age, then id.
    db.update(seatingTables)
      .set({ sortOrder: 0 })
      .where(eq(seatingTables.planId, PLAN[REC]!))
      .run();
    const shown = (await chart(app, REC)).tables.map((t) => t.name);
    const copy = await createPlan(app, REC, "Copy", PLAN[REC]);
    const copied = (await chart(app, REC, EDITOR, copy.id)).tables;
    expect(copied.map((t) => t.name)).toEqual(shown);
    expect(copied.map((t) => t.sortOrder)).toEqual([0, 1, 2]);
  });

  it("refuses a copy past what a wedding may copy in a day, writes nothing, and spends nothing on a blank plan", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    const today = new Date().toISOString().slice(0, 10);
    const spent = () =>
      db
        .select({
          weddingId: seatingCopyBudget.weddingId,
          day: seatingCopyBudget.day,
          copied: seatingCopyBudget.copied,
        })
        .from(seatingCopyBudget)
        .all()
        .toSorted((a, b) => a.weddingId.localeCompare(b.weddingId));
    // A blank plan copies nothing, so it writes no count at all.
    await createPlan(app, CER, "Blank first");
    expect(spent()).toEqual([]);
    // Two tables and three seats: a copy writes five rows. The wedding has
    // copied all but five today; another wedding's count from yesterday is
    // stale.
    db.insert(seatingCopyBudget)
      .values([
        { weddingId: W, day: today, copied: MAX_COPIED_ROWS_PER_DAY - 5 },
        { weddingId: "wed_other", day: "2000-01-01", copied: 7 },
      ])
      .run();
    const refusedBudget = () =>
      counterValue(CIRE_METRICS.seatingWriteRefused, { reason: "copy_budget" });
    const refusedBefore = await refusedBudget();

    await createPlan(app, REC, "Up to the line", PLAN[REC]);
    expect(spent()).toEqual([{ weddingId: W, day: today, copied: MAX_COPIED_ROWS_PER_DAY }]);

    const counts = () => ({
      plans: rowsIn(db, seatingPlans),
      tables: rowsIn(db, seatingTables),
      seats: rowsIn(db, seatingAssignments),
    });
    const before = counts();
    const refused = await req(app, "POST", plansPath(REC), EDITOR, {
      name: "Past it",
      copyFrom: PLAN[REC],
    });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toBe("copy_budget");
    expect(counts()).toEqual(before);
    expect(await refusedBudget()).toBe(refusedBefore + 1);

    // A blank plan copies nothing, so it is made and spends nothing, even
    // with the day's count past the ceiling.
    db.update(seatingCopyBudget)
      .set({ copied: MAX_COPIED_ROWS_PER_DAY + 1 })
      .where(eq(seatingCopyBudget.weddingId, W))
      .run();
    await createPlan(app, REC, "Blank");
    expect(spent()).toEqual([{ weddingId: W, day: today, copied: MAX_COPIED_ROWS_PER_DAY + 1 }]);
    // Another wedding's copies are counted on their own.
    const theirs = await req(
      app,
      "POST",
      `${theirBase}/seating/events/${OTHER_EVENT}/plans`,
      STRANGER,
      {
        name: "Their copy",
        copyFrom: PLAN[OTHER_EVENT],
      },
    );
    expect(theirs.status).toBe(200);
  });

  it("is refused by the database itself when a table names a plan of another event or wedding", async () => {
    const { app, db } = setup();
    const table = await createTable(app, REC, "Table 1");
    const now = new Date();
    for (const planId of [PLAN[CER]!, PLAN[OTHER_EVENT]!]) {
      expect(
        refusal(() =>
          db
            .insert(seatingTables)
            .values({
              id: `stb_wrong_${planId}`,
              weddingId: W,
              eventId: REC,
              planId,
              name: "Wrong",
              capacity: 8,
              createdAt: now,
              updatedAt: now,
            })
            .run(),
        ),
      ).toMatch(/seating table plan is not a plan of its event/);
      expect(
        refusal(() =>
          db.update(seatingTables).set({ planId }).where(eq(seatingTables.id, table.id)).run(),
        ),
      ).toMatch(/seating table plan is not a plan of its event/);
    }
    // Moving the table's event away from its plan is refused the same way.
    expect(
      refusal(() =>
        db.update(seatingTables).set({ eventId: CER }).where(eq(seatingTables.id, table.id)).run(),
      ),
    ).toMatch(/seating table plan is not a plan of its event/);
    expect(plansIn(db, REC).find((p) => p.id === PLAN[REC])?.tables).toEqual(["Table 1/8"]);
  });

  it("lets the copy be changed without touching the plan it was copied from", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    const before = plansIn(db, REC)[0]!;
    const copy = await createPlan(app, REC, "Copy", PLAN[REC]);
    const read = await chart(app, REC, EDITOR, copy.id);
    const [first, second] = read.tables;
    const seatInCopy = (guestId: string, tableId: string | null) =>
      req(app, "PUT", `${planPath(copy.id)}/guests/${guestId}`, EDITOR, { tableId });
    expect((await seatInCopy("g_ada", second!.id)).status).toBe(200);
    expect((await seatInCopy("g_bo", null)).status).toBe(200);
    expect(
      (await req(app, "PATCH", tablePath(first!.id), EDITOR, { name: "Head", capacity: 10 }))
        .status,
    ).toBe(200);
    expect(
      (
        await req(app, "POST", `${planPath(copy.id)}/tables`, EDITOR, {
          name: "Extra",
          capacity: 2,
        })
      ).status,
    ).toBe(200);
    expect((await req(app, "DELETE", tablePath(second!.id), EDITOR)).status).toBe(200);

    const byId = Object.fromEntries(plansIn(db, REC).map((p) => [p.id, p]));
    expect(byId[PLAN[REC]!]).toEqual(before);
    expect(byId[copy.id]).toMatchObject({
      tables: ["Head/10", "Extra/2"],
      seats: [],
    });
    expect((await chart(app, REC)).planId).toBe(PLAN[REC]);
  });

  it("copies nothing and answers 409 once the event holds as many plans as it can", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    for (let i = 1; i < MAX_PLANS_PER_EVENT; i++) await createPlan(app, REC, `Alt ${i}`);
    const counts = () => ({
      plans: rowsIn(db, seatingPlans),
      tables: rowsIn(db, seatingTables),
      seats: rowsIn(db, seatingAssignments),
    });
    const before = counts();
    for (const copyFrom of [PLAN[REC], undefined]) {
      const res = await req(app, "POST", plansPath(REC), EDITOR, { name: "One more", copyFrom });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe("plan_limit");
    }
    expect(counts()).toEqual(before);
    // The cap is per event.
    await createPlan(app, CER, "Ceremony alt");
  });

  it("refuses another wedding's plan, or another event's, on every plan write, and changes nothing", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    await seatTheirGuest(app);
    const theirs = PLAN[OTHER_EVENT]!;
    const before = { ours: plansIn(db, REC), theirs: plansIn(db, OTHER_EVENT) };
    for (const [method, path, body, error] of [
      ["POST", plansPath(OTHER_EVENT), { name: "Mine" }, "event_not_found"],
      ["POST", plansPath("evt_nope"), { name: "Mine" }, "event_not_found"],
      ["POST", plansPath(REC), { name: "Mine", copyFrom: theirs }, "plan_not_found"],
      // A plan of another event of this wedding is not this event's to copy.
      ["POST", plansPath(REC), { name: "Mine", copyFrom: PLAN[CER] }, "plan_not_found"],
      ["PATCH", planPath(theirs), { name: "Mine" }, "plan_not_found"],
      ["DELETE", planPath(theirs), undefined, "plan_not_found"],
      ["PUT", selectPath(REC), { planId: theirs }, "plan_not_found"],
      ["PUT", selectPath(REC), { planId: PLAN[CER] }, "plan_not_found"],
      ["PUT", selectPath(OTHER_EVENT), { planId: theirs }, "plan_not_found"],
      ["POST", `${planPath(theirs)}/tables`, { name: "Mine", capacity: 8 }, "plan_not_found"],
      ["PUT", `${planPath(theirs)}/guests/g_xeno`, { tableId: null }, "plan_not_found"],
    ] as const) {
      const res = await req(app, method, path, EDITOR, body);
      expect({ method, path, status: res.status, error: await errorOf(res) }).toEqual({
        method,
        path,
        status: 404,
        error,
      });
    }
    expect({ ours: plansIn(db, REC), theirs: plansIn(db, OTHER_EVENT) }).toEqual(before);
    expect(plansIn(db, CER).map((p) => p.name)).toEqual(["Plan 1"]);
  });

  it("refuses to delete the selected plan, and deletes an unused one with its tables and seats", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    const copy = await createPlan(app, REC, "Copy", PLAN[REC]);
    const selectedBefore = plansIn(db, REC).find((p) => p.id === PLAN[REC])!;

    const refused = await req(app, "DELETE", planPath(PLAN[REC]!), EDITOR);
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toBe("plan_selected");

    const renamed = await req(app, "PATCH", planPath(copy.id), EDITOR, { name: "Garden" });
    expect(await jsonBody(renamed)).toEqual({
      plan: { id: copy.id, name: "Garden", selected: false },
    });
    expect(plansIn(db, REC).find((p) => p.id === PLAN[REC])).toEqual(selectedBefore);

    expect(await jsonBody(await req(app, "DELETE", planPath(copy.id), EDITOR))).toEqual({
      ok: true,
    });
    expect(plansIn(db, REC)).toEqual([selectedBefore]);
    expect(db.select().from(seatingTables).where(eq(seatingTables.planId, copy.id)).all()).toEqual(
      [],
    );
    expect(
      db.select().from(seatingAssignments).where(eq(seatingAssignments.planId, copy.id)).all(),
    ).toEqual([]);
    const gone = await req(app, "DELETE", planPath(copy.id), EDITOR);
    expect(gone.status).toBe(404);
    expect(await errorOf(gone)).toBe("plan_not_found");
  });

  it("switches the selected plan, one at a time, and the venue file follows it", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    const copy = await createPlan(app, REC, "Copy", PLAN[REC]);
    const altTable = await createTable(app, REC, "Garden", 8, copy.id);
    await req(app, "PUT", `${planPath(copy.id)}/guests/g_ada`, EDITOR, { tableId: altTable.id });

    const select = await req(app, "PUT", selectPath(REC), EDITOR, { planId: copy.id });
    expect(await jsonBody(select)).toEqual({ ok: true });
    const selected = () =>
      plansIn(db, REC)
        .filter((p) => p.selected)
        .map((p) => p.id);
    expect(selected()).toEqual([copy.id]);
    const after = await chart(app, REC);
    expect(after.planId).toBe(copy.id);
    // The plan in use leads the list; the rest keep their age order.
    expect(after.plans.map((p) => [p.id, p.selected])).toEqual([
      [copy.id, true],
      [PLAN[REC], false],
    ]);
    const file = await req(app, "GET", `${base}/seating.csv`, OWNER);
    expect((await file.text()).split("\r\n")).toEqual([
      "Event,Table,Capacity,Guest,Household,RSVP",
      "Reception,Table 1,4,Bo,Alpha,Declined",
      "Reception,Table 2,6,Gwen,Gone,Invite withdrawn",
      "Reception,Garden,8,Ada,Alpha,Attending",
    ]);

    // Selecting the selected plan again changes nothing; an unknown plan
    // leaves the selection where it was.
    expect((await req(app, "PUT", selectPath(REC), EDITOR, { planId: copy.id })).status).toBe(200);
    const unknown = await req(app, "PUT", selectPath(REC), EDITOR, { planId: "spl_nope" });
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toBe("plan_not_found");
    expect(selected()).toEqual([copy.id]);
    // The first plan, unused now, can go.
    expect((await req(app, "DELETE", planPath(PLAN[REC]!), EDITOR)).status).toBe(200);
    expect(selected()).toEqual([copy.id]);
  });

  it("is refused by the database itself when a second plan of one event is selected", async () => {
    const { db } = setup();
    expect(
      refusal(() =>
        db
          .insert(seatingPlans)
          .values({
            id: "spl_second",
            weddingId: W,
            eventId: REC,
            name: "Second",
            selected: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .run(),
      ),
    ).toMatch(/UNIQUE constraint failed: seating_plans\.event_id/);
  });

  it("reads the selected plan by default, any plan of the event by id, and no other", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    const copy = await createPlan(app, REC, "Copy", PLAN[REC]);
    const read = await chart(app, REC);
    expect(read.planId).toBe(PLAN[REC]);
    expect(read.plans.map((p) => [p.id, p.name, p.selected])).toEqual([
      [PLAN[REC], "Plan 1", true],
      [copy.id, "Copy", false],
    ]);
    expect((await chart(app, REC, EDITOR, copy.id)).planId).toBe(copy.id);
    for (const planId of [PLAN[CER]!, PLAN[OTHER_EVENT]!, "spl_nope"]) {
      const res = await req(app, "GET", chartPath(REC, planId), EDITOR);
      expect({ planId, status: res.status, error: await errorOf(res) }).toEqual({
        planId,
        status: 404,
        error: "plan_not_found",
      });
    }
    // A plan id that is not one is refused before it is read.
    for (const query of ["?plan=spl%20x", "?plan=", `?plan=${"x".repeat(200)}`]) {
      const res = await req(app, "GET", `${chartPath(REC)}${query}`, EDITOR);
      expect({ query: query.slice(0, 20), status: res.status }).toEqual({
        query: query.slice(0, 20),
        status: 400,
      });
    }
    // An event with no plan yet: nothing selected, no tables, every guest it
    // invites unseated.
    const party = await chart(app, PARTY);
    expect(party).toMatchObject({ plans: [], planId: null, tables: [] });
    expect(party.guests.map((g) => [g.id, g.tableId])).toEqual([
      ["g_ada", null],
      ["g_bo", null],
    ]);
  });

  it("keeps every seat in every plan when a seated guest's reply or invitation changes", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    const copy = await createPlan(app, REC, "Copy", PLAN[REC]);
    const before = seatsByPlan(db, REC);
    const reply = await req(app, "PUT", `${base}/guests/g_ada/rsvps/${REC}`, EDITOR, {
      status: "declined",
    });
    expect(reply.status).toBe(200);
    db.update(families).set({ deactivatedAt: new Date() }).where(eq(families.id, "fam_a")).run();
    expect(seatsByPlan(db, REC)).toEqual(before);
    for (const planId of [PLAN[REC]!, copy.id]) {
      const ada = (await chart(app, REC, EDITOR, planId)).guests.find((g) => g.id === "g_ada");
      expect(ada).toMatchObject({ rsvp: "declined", withdrawn: true });
      expect(ada?.tableId).not.toBeNull();
    }
  });

  it("answers 429 to an editor past the plan-write budget, writes nothing, and leaves other writes alone", async () => {
    const { app, db } = setup("gold", createRateLimiter({ maxRequests: 2, windowMs: 60_000 }));
    const alt = await createPlan(app, REC, "Alt");
    expect((await req(app, "DELETE", planPath(alt.id), EDITOR)).status).toBe(200);
    const before = plansIn(db, REC);
    const refused = await req(app, "POST", plansPath(REC), EDITOR, { name: "Third" });
    expect(refused.status).toBe(429);
    const refusedDelete = await req(app, "DELETE", planPath(PLAN[REC]!), EDITOR);
    expect(refusedDelete.status).toBe(429);
    expect(plansIn(db, REC)).toEqual(before);
    // The budget is the plan writes': a table and a seat still land.
    const table = await createTable(app, REC, "Table 1");
    expect(
      (await req(app, "PUT", seatPath(REC, "g_ada"), EDITOR, { tableId: table.id })).status,
    ).toBe(200);
    // Another person's budget is their own.
    expect((await req(app, "POST", plansPath(REC), OWNER, { name: "Owner's" })).status).toBe(200);
  });

  it("gives each person ten plan writes a minute by default, counted before the role gate", async () => {
    // The Worker's own limiter, which every app without one shares: a profile
    // no other test uses keeps this test's count its own.
    const db = buildDb();
    const app = createApp(db, { osnTestKey: auth.key });
    const probe = "usr_plan_limit_probe";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await req(app, "POST", plansPath(REC), probe, { name: `P${i}` })).status);
    }
    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 403), 429]);
    expect(rowsIn(db, seatingPlans)).toBe(3);
  });

  it("refuses a malformed plan body", async () => {
    const { app, db } = setup();
    const before = rowsIn(db, seatingPlans);
    for (const body of [
      {},
      { name: "" },
      { name: "   " },
      { name: "x".repeat(81) },
      { name: "P", copyFrom: "spl x" },
      { name: "P", copyFrom: 3 },
      "{not json",
    ]) {
      const res = await req(app, "POST", plansPath(REC), EDITOR, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    for (const body of [{}, { name: "" }]) {
      const res = await req(app, "PATCH", planPath(PLAN[REC]!), EDITOR, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    for (const body of [{}, { planId: "" }, { planId: "spl x" }]) {
      const res = await req(app, "PUT", selectPath(REC), EDITOR, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(rowsIn(db, seatingPlans)).toBe(before);
    // A name at its limit is taken.
    expect((await req(app, "POST", plansPath(REC), EDITOR, { name: "x".repeat(80) })).status).toBe(
      200,
    );
  });

  it("counts each plan write by action and each refusal by its reason", async () => {
    const { app, db } = setup();
    await arranged(app, db);
    const plan = (action: string) => counterValue(CIRE_METRICS.seatingPlanWrite, { action });
    const refused = (reason: string) => counterValue(CIRE_METRICS.seatingWriteRefused, { reason });
    const count = async () => ({
      create: await plan("create"),
      duplicate: await plan("duplicate"),
      rename: await plan("rename"),
      select: await plan("select"),
      remove: await plan("remove"),
      limit: await refused("plan_limit"),
      selected: await refused("plan_selected"),
    });
    const before = await count();
    const blank = await createPlan(app, REC, "Blank");
    const copy = await createPlan(app, REC, "Copy", PLAN[REC]);
    await req(app, "PATCH", planPath(copy.id), EDITOR, { name: "Garden" });
    await req(app, "PUT", selectPath(REC), EDITOR, { planId: copy.id });
    await req(app, "DELETE", planPath(copy.id), EDITOR);
    await req(app, "DELETE", planPath(blank.id), EDITOR);
    for (let i = rowsIn(db, seatingPlans); i < MAX_PLANS_PER_EVENT + 2; i++) {
      // Two plans sit at the ceremony and the other wedding's event.
      await createPlan(app, REC, `Alt ${i}`);
    }
    await req(app, "POST", plansPath(REC), EDITOR, { name: "One more" });
    const now = await count();
    expect(
      Object.fromEntries(
        Object.entries(now).map(([k, v]) => [k, v - before[k as keyof typeof before]]),
      ),
    ).toEqual({
      create: 1 + (MAX_PLANS_PER_EVENT - 2),
      duplicate: 1,
      rename: 1,
      select: 1,
      remove: 1,
      limit: 1,
      selected: 1,
    });
  });
});

describe("seating — the event's plan in use, at the event's own addresses", () => {
  const eventTables = (eventId: string) => `${base}/seating/events/${eventId}/tables`;
  const eventSeat = (eventId: string, guestId: string) =>
    `${base}/seating/events/${eventId}/guests/${guestId}`;

  it("makes an event's first plan, in use, with its first table, and puts later tables in it", async () => {
    const { app, db } = setup();
    const first = await req(app, "POST", eventTables(PARTY), EDITOR, {
      name: "Table 1",
      capacity: 6,
    });
    expect(first.status).toBe(200);
    const second = await req(app, "POST", eventTables(PARTY), EDITOR, {
      name: "Table 2",
      capacity: 4,
    });
    expect(second.status).toBe(200);
    expect(plansIn(db, PARTY).map((p) => [p.name, p.selected, p.tables])).toEqual([
      ["Plan 1", true, ["Table 1/6", "Table 2/4"]],
    ]);
    const read = await chart(app, PARTY);
    expect(read.planId).toBe(plansIn(db, PARTY)[0]!.id);
    expect(read.tables.map((t) => t.name)).toEqual(["Table 1", "Table 2"]);
  });

  it("puts a table, a seat and an order in the plan in use, and in no other plan", async () => {
    const { app, db } = setup();
    const one = await createTable(app, REC, "Table 1");
    const alt = await createPlan(app, REC, "Alt", PLAN[REC]);
    const altBefore = plansIn(db, REC).find((p) => p.id === alt.id);
    const added = await req(app, "POST", eventTables(REC), EDITOR, {
      name: "Table 2",
      capacity: 8,
    });
    const two = ((await added.json()) as { table: TableDto }).table;
    expect(
      await jsonBody(await req(app, "PUT", eventSeat(REC, "g_ada"), EDITOR, { tableId: two.id })),
    ).toEqual({ guestId: "g_ada", tableId: two.id });
    expect(
      (
        await req(app, "PATCH", `${eventTables(REC)}/reorder`, EDITOR, {
          orderedIds: [two.id, one.id],
        })
      ).status,
    ).toBe(200);
    const inUse = plansIn(db, REC).find((p) => p.id === PLAN[REC]);
    expect(inUse).toMatchObject({ tables: ["Table 2/8", "Table 1/8"], seats: ["g_ada@Table 2"] });
    expect(plansIn(db, REC).find((p) => p.id === alt.id)).toEqual(altBefore);
    // A table of another plan is not the plan in use's to seat at.
    const altTable = await createTable(app, REC, "Alt table", 8, alt.id);
    const wrong = await req(app, "PUT", eventSeat(REC, "g_bo"), EDITOR, { tableId: altTable.id });
    expect(wrong.status).toBe(404);
    expect(await errorOf(wrong)).toBe("table_not_found");
    expect(
      await jsonBody(await req(app, "PUT", eventSeat(REC, "g_ada"), EDITOR, { tableId: null })),
    ).toEqual({ guestId: "g_ada", tableId: null });
    expect(plansIn(db, REC).find((p) => p.id === PLAN[REC])?.seats).toEqual([]);
  });

  it("refuses another wedding's event or an unknown one, and seats nobody at an event with no plan", async () => {
    const { app, db } = setup();
    for (const eventId of [OTHER_EVENT, "evt_nope"]) {
      const table = await req(app, "POST", eventTables(eventId), EDITOR, {
        name: "T",
        capacity: 8,
      });
      expect({ eventId, status: table.status, error: await errorOf(table) }).toEqual({
        eventId,
        status: 404,
        error: "event_not_found",
      });
      const seat = await req(app, "PUT", eventSeat(eventId, "g_ada"), EDITOR, { tableId: null });
      expect({ eventId, status: seat.status, error: await errorOf(seat) }).toEqual({
        eventId,
        status: 404,
        error: "event_not_found",
      });
    }
    expect(plansIn(db, OTHER_EVENT).map((p) => p.tables)).toEqual([[]]);
    // The after party has no plan: clearing a seat changes nothing, and a
    // table there does not exist.
    expect(
      await jsonBody(await req(app, "PUT", eventSeat(PARTY, "g_ada"), EDITOR, { tableId: null })),
    ).toEqual({ guestId: "g_ada", tableId: null });
    const noTable = await req(app, "PUT", eventSeat(PARTY, "g_ada"), EDITOR, { tableId: "stb_x" });
    expect(noTable.status).toBe(404);
    expect(await errorOf(noTable)).toBe("table_not_found");
    // A reorder at an event with no plan, or another wedding's, writes nothing.
    expect(
      (await req(app, "PATCH", `${eventTables(PARTY)}/reorder`, EDITOR, { orderedIds: ["stb_x"] }))
        .status,
    ).toBe(200);
    expect(plansIn(db, PARTY)).toEqual([]);
  });

  it("refuses there what the plan's own addresses refuse, and writes nothing", async () => {
    const { app, db } = setup();
    const small = await createTable(app, REC, "Small", 1);
    await req(app, "PUT", eventSeat(REC, "g_ada"), EDITOR, { tableId: small.id });
    const before = plansIn(db, REC);
    for (const [guestId, status, error] of [
      // Bo fits nowhere at a full table; Cy is not invited to the reception;
      // Xeno is another wedding's; Gwen's household was withdrawn.
      ["g_bo", 409, "table_full"],
      ["g_cy", 404, "guest_not_found"],
      ["g_xeno", 404, "guest_not_found"],
      ["g_host", 404, "guest_not_found"],
      ["g_gone", 409, "household_withdrawn"],
    ] as const) {
      const res = await req(app, "PUT", eventSeat(REC, guestId), EDITOR, { tableId: small.id });
      expect({ guestId, status: res.status, error: await errorOf(res) }).toEqual({
        guestId,
        status,
        error,
      });
    }
    expect(plansIn(db, REC)).toEqual(before);

    const now = new Date();
    db.insert(seatingTables)
      .values(
        Array.from({ length: MAX_TABLES_PER_PLAN - 1 }, (_, i) => ({
          id: `stb_fill_${i}`,
          weddingId: W,
          eventId: REC,
          planId: PLAN[REC]!,
          name: `T${i}`,
          capacity: 8,
          sortOrder: i + 1,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    const limited = () => counterValue(CIRE_METRICS.seatingWriteRefused, { reason: "table_limit" });
    const limitedBefore = await limited();
    const full = await req(app, "POST", eventTables(REC), EDITOR, {
      name: "One more",
      capacity: 8,
    });
    expect(full.status).toBe(409);
    expect(await errorOf(full)).toBe("table_limit");
    expect(rowsIn(db, seatingTables)).toBe(MAX_TABLES_PER_PLAN);
    expect(await limited()).toBe(limitedBefore + 1);
  });

  it("counts the plan it makes once, and each table it adds", async () => {
    const { app } = setup();
    const planMade = () => counterValue(CIRE_METRICS.seatingPlanWrite, { action: "create" });
    const tableMade = () => counterValue(CIRE_METRICS.seatingTableWrite, { action: "create" });
    const before = { plans: await planMade(), tables: await tableMade() };
    // The first table makes the plan; the second finds it.
    for (const [name, plans] of [
      ["Table 1", 1],
      ["Table 2", 1],
    ] as const) {
      const res = await req(app, "POST", eventTables(PARTY), EDITOR, { name, capacity: 8 });
      expect(res.status).toBe(200);
      expect(await planMade()).toBe(before.plans + plans);
    }
    expect(await tableMade()).toBe(before.tables + 2);
  });

  it("refuses a viewer, a wedding below Gold and a malformed body at each of them", async () => {
    const { app } = setup();
    const table = await createTable(app, REC, "Table 1");
    for (const [method, path, body] of [
      ["POST", eventTables(REC), { name: "T", capacity: 8 }],
      ["PATCH", `${eventTables(REC)}/reorder`, { orderedIds: [table.id] }],
      ["PUT", eventSeat(REC, "g_ada"), { tableId: table.id }],
    ] as const) {
      const viewer = await req(app, method, path, VIEWER, body);
      expect({ path, status: viewer.status, error: await errorOf(viewer) }).toEqual({
        path,
        status: 403,
        error: "read_only_role",
      });
      const malformed = await req(app, method, path, EDITOR, "{");
      expect({ path, status: malformed.status }).toEqual({ path, status: 400 });
    }
    const { app: ivory } = setup("ivory");
    const below = await req(ivory, "POST", eventTables(REC), OWNER, { name: "T", capacity: 8 });
    expect(below.status).toBe(402);
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
      .values({
        tableId: cer.id,
        planId: PLAN[CER]!,
        eventId: CER,
        guestId: "g_host",
        createdAt: new Date(),
      })
      .run();
    // A plan not selected is never in the file.
    const alt = await createPlan(app, REC, "Alt", PLAN[REC]);
    const altTable = await createTable(app, REC, "Alt table", 8, alt.id);
    await req(app, "PUT", `${planPath(alt.id)}/guests/g_ada`, EDITOR, { tableId: altTable.id });
    // Another wedding's seat is never in this wedding's file.
    await seatTheirGuest(app);

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

  it("prints no other wedding's table, even one filed under this wedding's plan", async () => {
    const { app, db } = setup();
    await seatTheirGuest(app);
    // The database refuses such a row itself; with that check dropped, the
    // file's join on the event still leaves it out.
    db.$client.exec("DROP TRIGGER seating_tables_plan_at_event");
    const now = new Date();
    db.insert(seatingTables)
      .values({
        id: "stb_smuggled",
        weddingId: "wed_other",
        eventId: OTHER_EVENT,
        planId: PLAN[REC]!,
        name: "Smuggled",
        capacity: 8,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(seatingAssignments)
      .values({
        tableId: "stb_smuggled",
        planId: PLAN[REC]!,
        eventId: OTHER_EVENT,
        guestId: "g_xeno",
        createdAt: now,
      })
      .run();
    const file = await (await req(app, "GET", `${base}/seating.csv`, OWNER)).text();
    expect(file).toBe("Event,Table,Capacity,Guest,Household,RSVP");
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
    // A copy of the reception's plan holds two more seats; it is not selected,
    // so the file prints neither, and the count counts neither.
    await createPlan(app, REC, "Alt", PLAN[REC]);
    // Another wedding's seat is not this wedding's.
    await seatTheirGuest(app);
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
    // Seating in another wedding's plan names the plan, not this wedding's
    // table that was sent with it.
    const theirSeat = await req(app, "PUT", seatPath(OTHER_EVENT, "g_xeno"), EDITOR, {
      tableId: one.id,
    });
    expect(theirSeat.status).toBe(404);
    expect(await errorOf(theirSeat)).toBe("plan_not_found");
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
    const alt = await createPlan(app, REC, "Secret plan");
    // Every D1 error reaches a handler as a defect; dropping the chart's
    // tables is the cheapest way to raise one on every route.
    db.$client.exec(
      "DROP TABLE seating_assignments; DROP TABLE seating_tables; DROP TABLE seating_plans;",
    );
    const calls: Array<[string, string, string, unknown]> = [
      ["chart", "GET", chartPath(REC), undefined],
      ["createPlan", "POST", plansPath(REC), { name: "Secret plan", copyFrom: PLAN[REC] }],
      ["renamePlan", "PATCH", planPath(alt.id), { name: "Secret plan" }],
      ["removePlan", "DELETE", planPath(alt.id), undefined],
      ["selectPlan", "PUT", selectPath(REC), { planId: alt.id }],
      ["createTable", "POST", tablesPath(REC), { name: "Secret table", capacity: 8 }],
      ["reorderTables", "PATCH", `${tablesPath(REC)}/reorder`, { orderedIds: [table.id] }],
      ["updateTable", "PATCH", tablePath(table.id), { name: "Secret table" }],
      ["removeTable", "DELETE", tablePath(table.id), undefined],
      ["seat", "PUT", seatPath(REC, "g_ada"), { tableId: table.id }],
      // The event's own addresses, which act on its plan in use.
      [
        "createTable",
        "POST",
        `${base}/seating/events/${REC}/tables`,
        { name: "Secret table", capacity: 8 },
      ],
      [
        "reorderTables",
        "PATCH",
        `${base}/seating/events/${REC}/tables/reorder`,
        { orderedIds: [table.id] },
      ],
      ["seat", "PUT", `${base}/seating/events/${REC}/guests/g_ada`, { tableId: table.id }],
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
      expect(logs).not.toContain("Secret plan");
      expect(logs).not.toContain("Ada");
    }
    const file = await req(app, "GET", `${base}/seating.csv`, OWNER);
    expect(file.status).toBe(500);
    expect(await jsonBody(file)).toEqual({ error: "Internal error" });
  });
});
