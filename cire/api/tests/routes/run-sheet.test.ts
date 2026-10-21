import { beforeAll, describe, expect, it } from "bun:test";

import { events, runOfShowItems, taskAssignees, tasks, weddingHosts, weddings } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import type { OsnProfileDisplay } from "../../src/services/osn-bridge";
import { appRequest, failStatements, jsonBody, setTier } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

/**
 * GET /api/organiser/weddings/:weddingId/run-sheet — the day's events and
 * timed tasks, narrowed on the server to what the reader's scope entitles them
 * to. This is a permissions test: every case here is a disclosure a helper
 * scoped to their own tasks must never receive, or a gate that must refuse.
 */

const WED = "wed_rs";
const PATH = `/api/organiser/weddings/${WED}/run-sheet`;

const OWNER = "usr_rs_owner";
const EDITOR = "usr_rs_editor";
const VIEWER = "usr_rs_viewer";
const HELPER = "usr_rs_helper";
const GUS = "usr_rs_gus";
const FULL = "usr_rs_full";
const IDLE = "usr_rs_idle";
const STRANGER = "usr_rs_stranger";

const SEAT = {
  owner: "whost_rs_owner",
  editor: "whost_rs_editor",
  viewer: "whost_rs_viewer",
  helper: "whost_rs_helper",
  gus: "whost_rs_gus",
  full: "whost_rs_full",
  idle: "whost_rs_idle",
} as const;

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/**
 * One Gold wedding. Events: arrival 14:30, speeches 16:00, first dance 20:00,
 * all Sydney (+10:00 in June). Tasks:
 *  - `programmes`: arrival −30, held by the helper;
 *  - `rings`: arrival +0, held by the helper and gus;
 *  - `cue`: speeches −10, held by gus and the editor;
 *  - `candles`: `day_of`, untimed, held by nobody;
 *  - `flowers`: `week_of`, fixed 12:00 Kolkata, held by nobody;
 *  - `cake`: `6m`, frozen at 17:00 Sydney when its event was removed;
 *  - `stray`: linked (by raw SQL, which no writer does) to another wedding's
 *    event, held by the helper;
 *  - `thanks`: `1m`, untimed: never on the run sheet.
 * Runs of show, each stored in an order that is not clock order: arrival
 * (14:45 "Welcome drinks", 14:35 "Valet opens"), speeches (16:20 "Best man",
 * 16:05 "Father of the bride"); the first dance has none.
 */
function build(tier: "ivory" | "gold" = "gold") {
  const db = createDb(":memory:");
  const now = new Date();
  insertWedding(db, { id: WED, slug: "rs", displayName: "RS", tier });
  insertWedding(db, {
    id: "wed_rs_other",
    slug: "rs-other",
    displayName: "Other",
    owners: ["usr_b"],
  });
  const seat = (id: string, osnProfileId: string, role: string, scope: "own" | "full" = "own") =>
    db
      .insert(weddingHosts)
      .values({
        id,
        weddingId: WED,
        osnProfileId,
        addedByOsnProfileId: OWNER,
        role: role as "owner",
        runSheetScope: scope,
        createdAt: now,
      })
      .run();
  seat(SEAT.owner, OWNER, "owner");
  seat(SEAT.editor, EDITOR, "editor");
  seat(SEAT.viewer, VIEWER, "viewer");
  seat(SEAT.helper, HELPER, "helper");
  seat(SEAT.gus, GUS, "helper");
  seat(SEAT.full, FULL, "helper", "full");
  seat(SEAT.idle, IDLE, "helper");
  setTier(db, WED, tier);

  const ev = (id: string, weddingId: string, name: string, startAt: string, sortOrder: number) => ({
    id,
    weddingId,
    slug: id,
    name,
    startAt,
    endAt: "",
    timezone: "Australia/Sydney",
    venueName: `${name} venue`,
    address: `${name} address`,
    description: `${name} description`,
    dressCodeDescription: `${name} dress code`,
    sortOrder,
  });
  db.insert(events)
    .values([
      ev("evt_arrival", WED, "Guest arrival", "2099-06-20T14:30:00+10:00", 0),
      ev("evt_speeches", WED, "Speeches", "2099-06-20T16:00:00+10:00", 1),
      ev("evt_dance", WED, "First dance", "2099-06-20T20:00:00+10:00", 2),
      ev("evt_theirs", "wed_rs_other", "Their secret", "2099-06-20T13:00:00+10:00", 0),
    ])
    .run();
  const item = (
    eventId: string,
    weddingId: string,
    sortOrder: number,
    time: string,
    label: string,
  ) => ({
    eventId,
    weddingId,
    sortOrder,
    time,
    label,
  });
  db.insert(runOfShowItems)
    .values([
      item("evt_arrival", WED, 0, "14:45", "Welcome drinks"),
      item("evt_arrival", WED, 1, "14:35", "Valet opens"),
      item("evt_speeches", WED, 0, "16:20", "Best man"),
      item("evt_speeches", WED, 1, "16:05", "Father of the bride"),
      item("evt_theirs", "wed_rs_other", 0, "13:10", "Their secret toast"),
    ])
    .run();

  const task = (
    id: string,
    bucket: string,
    run: Partial<typeof tasks.$inferInsert> = {},
    sortOrder = 0,
  ) => ({
    id,
    weddingId: WED,
    title: `Title ${id}`,
    notes: `Notes ${id}`,
    timeframeBucket: bucket,
    sortOrder,
    createdAt: now,
    ...run,
  });
  db.insert(tasks)
    .values([
      task("programmes", "day_of", { eventId: "evt_arrival", runOffsetMinutes: -30 }),
      task("rings", "day_of", { eventId: "evt_arrival", runOffsetMinutes: 0 }, 1),
      task("cue", "week_of", { eventId: "evt_speeches", runOffsetMinutes: -10 }),
      task("candles", "day_of"),
      task("flowers", "week_of", {
        runAt: "2099-06-20T12:00:00+05:30",
        runTimezone: "Asia/Kolkata",
      }),
      task("cake", "6m", {
        runAt: "2099-06-20T17:00:00+10:00",
        runTimezone: "Australia/Sydney",
        eventRemovedAt: now,
      }),
      task("thanks", "1m"),
    ])
    .run();
  // A link to another wedding's event: no API path writes one.
  db.$client.run(
    `INSERT INTO tasks (id, wedding_id, title, timeframe_bucket, created_at, event_id, run_offset_minutes) VALUES ('stray', '${WED}', 'Title stray', 'day_of', 1, 'evt_theirs', 5)`,
  );
  const hold = (taskId: string, hostId: string) =>
    db.insert(taskAssignees).values({ taskId, hostId, weddingId: WED, assignedAt: now }).run();
  hold("programmes", SEAT.helper);
  hold("rings", SEAT.helper);
  hold("rings", SEAT.gus);
  hold("cue", SEAT.gus);
  hold("cue", SEAT.editor);
  hold("stray", SEAT.helper);
  return db;
}

type Resolver = (ids: readonly string[]) => Promise<Map<string, OsnProfileDisplay>>;

function buildApp(db: TestDb, options: { resolver?: Resolver; limit?: number } = {}) {
  return createApp(db, {
    osnTestKey: auth.key,
    runSheetReadLimiter: createRateLimiter({
      maxRequests: options.limit ?? 10_000,
      windowMs: 60_000,
    }),
    resolveOsnProfileDisplays: options.resolver,
  });
}

async function get(app: ReturnType<typeof buildApp>, who: string | undefined, path = PATH) {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${await auth.sign(who)}`;
  return appRequest(app, path, { headers });
}

type Sheet = {
  scope: "own" | "full";
  viewerHostId: string;
  items: Array<{ kind: "event" | "task"; id: string } & Record<string, unknown>>;
  people: Array<{ hostId: string; osnProfileId: string } & Record<string, unknown>>;
};

async function sheetFor(who: string, db = build(), resolver?: Resolver): Promise<Sheet> {
  const res = await get(buildApp(db, { resolver }), who);
  expect(res.status, who).toBe(200);
  return (await res.json()) as Sheet;
}

const kinds = (sheet: Sheet, kind: "event" | "task") =>
  sheet.items.filter((i) => i.kind === kind).map((i) => i.id);

const EVERY_TASK = ["programmes", "rings", "cue", "flowers", "cake", "candles", "stray"];

describe("GET /run-sheet: what each reader is given", () => {
  for (const [who, seat] of [
    [OWNER, SEAT.owner],
    [EDITOR, SEAT.editor],
    [VIEWER, SEAT.viewer],
    [FULL, SEAT.full],
  ] as const) {
    it(`gives ${who} every timed and day-of task, every event and every holder`, async () => {
      const sheet = await sheetFor(who);
      expect(sheet.scope).toBe("full");
      expect(sheet.viewerHostId).toBe(seat);
      // Kolkata's noon is 16:30 in Sydney: after the speeches, by instant.
      expect(sheet.items.map((i) => i.id)).toEqual([
        "programmes",
        "evt_arrival",
        "rings",
        "cue",
        "evt_speeches",
        "flowers",
        "cake",
        "evt_dance",
        "candles",
        "stray",
      ]);
      expect(kinds(sheet, "task").toSorted()).toEqual(EVERY_TASK.toSorted());
      expect(sheet.people.map((p) => p.hostId).toSorted()).toEqual(
        [SEAT.editor, SEAT.helper, SEAT.gus].toSorted(),
      );
    });
  }

  it("gives a helper scoped to their own tasks those tasks, their events and their co-holders, and nothing else", async () => {
    const db = build();
    const res = await get(buildApp(db), HELPER);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const sheet = JSON.parse(raw) as Sheet;

    expect(sheet.scope).toBe("own");
    expect(sheet.viewerHostId).toBe(SEAT.helper);
    expect(sheet.items.map((i) => i.id)).toEqual(["programmes", "evt_arrival", "rings", "stray"]);
    expect(sheet.people.map((p) => p.hostId).toSorted()).toEqual(
      [SEAT.helper, SEAT.gus].toSorted(),
    );

    // Nothing of what they do not hold: not another seat's task, an event
    // their tasks do not link, a person who holds none of theirs, an unheld
    // day-of task, or another wedding's event a stray link names.
    for (const secret of [
      "Speeches",
      "First dance",
      "Title cue",
      "Notes cue",
      "candles",
      "flowers",
      "cake",
      "thanks",
      "evt_speeches",
      "evt_dance",
      "evt_theirs",
      "Their secret",
      SEAT.editor,
      EDITOR,
      SEAT.viewer,
      SEAT.full,
      SEAT.idle,
      "description",
      "dress code",
      // Only the runs of show of the events their tasks link to.
      "Best man",
      "Father of the bride",
      "Their secret toast",
    ]) {
      expect(raw, secret).not.toContain(secret);
    }
    expect(sheet.items.find((i) => i.id === "evt_arrival")?.runOfShow).toEqual([
      { time: "14:45", label: "Welcome drinks" },
      { time: "14:35", label: "Valet opens" },
    ]);
  });

  it("gives every reader an event's name, times, zone, venue name, address and run of show, and no other field", async () => {
    for (const who of [HELPER, OWNER]) {
      const sheet = await sheetFor(who);
      const arrival = sheet.items.find((i) => i.id === "evt_arrival");
      expect(arrival, who).toEqual({
        kind: "event",
        id: "evt_arrival",
        name: "Guest arrival",
        startAt: "2099-06-20T14:30:00+10:00",
        endAt: "",
        timezone: "Australia/Sydney",
        venueName: "Guest arrival venue",
        address: "Guest arrival address",
        // The organiser's order, as stored: the portal orders it from the start.
        runOfShow: [
          { time: "14:45", label: "Welcome drinks" },
          { time: "14:35", label: "Valet opens" },
        ],
      });
    }
  });

  for (const who of [OWNER, EDITOR, VIEWER, FULL]) {
    it(`gives ${who} every event's run of show, and an empty one for an event with none`, async () => {
      const sheet = await sheetFor(who);
      const runOfShow = (id: string) => sheet.items.find((i) => i.id === id)?.runOfShow;
      expect(runOfShow("evt_arrival")).toEqual([
        { time: "14:45", label: "Welcome drinks" },
        { time: "14:35", label: "Valet opens" },
      ]);
      expect(runOfShow("evt_speeches")).toEqual([
        { time: "16:20", label: "Best man" },
        { time: "16:05", label: "Father of the bride" },
      ]);
      expect(runOfShow("evt_dance")).toEqual([]);
    });
  }

  it("answers a task's derived time, its holders and its status, and no other field", async () => {
    const sheet = await sheetFor(HELPER);
    expect(sheet.items.find((i) => i.id === "programmes")).toEqual({
      kind: "task",
      id: "programmes",
      title: "Title programmes",
      notes: "Notes programmes",
      status: "open",
      runAt: "2099-06-20T14:00:00+10:00",
      runTimezone: "Australia/Sydney",
      eventId: "evt_arrival",
      runOffsetMinutes: -30,
      anchored: true,
      eventRemoved: false,
      assigneeHostIds: [SEAT.helper],
    });
    // Another wedding's event never shows through a stray link.
    expect(sheet.items.find((i) => i.id === "stray")).toMatchObject({
      eventId: null,
      anchored: false,
      runAt: null,
    });
  });

  it("marks a task whose event was removed, at the time it kept", async () => {
    const sheet = await sheetFor(OWNER);
    expect(sheet.items.find((i) => i.id === "cake")).toMatchObject({
      runAt: "2099-06-20T17:00:00+10:00",
      eventRemoved: true,
      anchored: false,
    });
  });

  it("gives another helper scoped to their own tasks only theirs", async () => {
    const sheet = await sheetFor(GUS);
    expect(sheet.items.map((i) => i.id)).toEqual(["evt_arrival", "rings", "cue", "evt_speeches"]);
    expect(sheet.people.map((p) => p.hostId).toSorted()).toEqual(
      [SEAT.helper, SEAT.gus, SEAT.editor].toSorted(),
    );
  });

  it("answers a helper who holds nothing an empty run sheet, and asks for no names", async () => {
    const asked: string[][] = [];
    const resolver: Resolver = async (ids) => {
      asked.push([...ids]);
      return new Map();
    };
    const sheet = await sheetFor(IDLE, build(), resolver);
    expect(sheet).toEqual({ scope: "own", viewerHostId: SEAT.idle, items: [], people: [] });
    expect(asked).toEqual([]);
  });

  it("lists a done task in its slot", async () => {
    const db = build();
    db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "rings")).run();
    const sheet = await sheetFor(HELPER, db);
    expect(sheet.items.find((i) => i.id === "rings")).toMatchObject({ status: "done" });
    expect(sheet.items.map((i) => i.id)).toEqual(["programmes", "evt_arrival", "rings", "stray"]);
  });
});

describe("GET /run-sheet: names", () => {
  const display = (handle: string): OsnProfileDisplay => ({
    handle,
    displayName: `${handle} name`,
    avatarUrl: null,
  });

  it("names the people holding the reader's tasks, asking for them and no one else", async () => {
    const asked: string[][] = [];
    const resolver: Resolver = async (ids) => {
      asked.push([...ids]);
      return new Map(ids.map((id) => [id, display(id.replace("usr_", ""))]));
    };
    const sheet = await sheetFor(HELPER, build(), resolver);
    expect(asked.map((ids) => ids.toSorted())).toEqual([[GUS, HELPER].toSorted()]);
    expect(sheet.people.find((p) => p.hostId === SEAT.gus)).toEqual({
      hostId: SEAT.gus,
      osnProfileId: GUS,
      handle: "rs_gus",
      displayName: "rs_gus name",
    });
  });

  it("answers with profile ids when the name lookup throws, and says so in the log", async () => {
    const resolver: Resolver = () => Promise.reject(new Error("arc down"));
    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await get(buildApp(build(), { resolver }), HELPER);
    });
    expect(res?.status).toBe(200);
    const sheet = (await res!.json()) as Sheet;
    expect(sheet.people.map((p) => Object.keys(p).toSorted())).toEqual([
      ["hostId", "osnProfileId"],
      ["hostId", "osnProfileId"],
    ]);
    expect(logs).toContain("run sheet names unresolved");
    expect(logs).not.toContain(GUS);
  });
});

describe("GET /run-sheet: gates", () => {
  it("401s with no session", async () => {
    expect((await get(buildApp(build()), undefined)).status).toBe(401);
  });

  it("403s a stranger and 404s a wedding that does not exist", async () => {
    const app = buildApp(build());
    const stranger = await get(app, STRANGER);
    expect(stranger.status).toBe(403);
    expect(await jsonBody(stranger)).toEqual({ error: "forbidden" });
    const missing = await get(app, OWNER, "/api/organiser/weddings/wed_nope/run-sheet");
    expect(missing.status).toBe(404);
  });

  it("402s every role below Gold, a helper included, with nothing of the day in the answer", async () => {
    const app = buildApp(build("ivory"));
    for (const who of [OWNER, EDITOR, VIEWER, HELPER, FULL]) {
      const res = await get(app, who);
      expect(res.status, who).toBe(402);
      const body = (await jsonBody(res)) as { error: string; tier: string };
      expect(body.error).toBe("payment_required");
      expect(body.tier).toBe("gold");
    }
  });

  it("refuses on the role before the tier", async () => {
    expect((await get(buildApp(build("ivory")), STRANGER)).status).toBe(403);
  });

  it("refuses a deleted wedding as one that does not exist", async () => {
    const db = build();
    db.update(weddings).set({ deletedAt: new Date() }).where(eq(weddings.id, WED)).run();
    expect((await get(buildApp(db), OWNER)).status).toBe(404);
  });

  it("429s an organiser past the limit, and every organiser has a limit of their own", async () => {
    const app = buildApp(build(), { limit: 1 });
    expect((await get(app, HELPER)).status).toBe(200);
    const refused = await get(app, HELPER);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect((await get(app, OWNER)).status).toBe(200);
    // A refusal from the gates spends nothing.
    expect((await get(app, STRANGER)).status).toBe(403);
    expect((await get(app, STRANGER)).status).toBe(403);
  });

  it("is never cached", async () => {
    const res = await get(buildApp(build()), OWNER);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /run-sheet: failure and counting", () => {
  const counted = (scope: string, result: string) =>
    counterValue(CIRE_METRICS.runSheetReadCompleted, { scope, result });

  it("counts each read by the scope it served", async () => {
    const app = buildApp(build());
    const own = await counted("own", "ok");
    const full = await counted("full", "ok");
    expect((await get(app, HELPER)).status).toBe(200);
    expect((await get(app, OWNER)).status).toBe(200);
    expect((await counted("own", "ok")) - own).toBe(1);
    expect((await counted("full", "ok")) - full).toBe(1);
  });

  it("answers 500 when the database fails, logging the wedding and the scope and no task, name or address", async () => {
    const db = build();
    const app = buildApp(db);
    const before = await counted("own", "error");
    const failure = failStatements(db, (text) => text.includes('from "tasks"'));
    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await get(app, HELPER);
    });
    failure.restore();
    expect(res?.status).toBe(500);
    expect(await jsonBody(res!)).toEqual({ error: "Internal error" });
    expect(logs).toContain("run sheet read failed");
    expect(logs).toContain(WED);
    for (const secret of [
      "Title",
      "Notes",
      "address",
      "Guest arrival",
      "Welcome drinks",
      HELPER,
      SEAT.helper,
    ]) {
      expect(logs, secret).not.toContain(secret);
    }
    expect((await counted("own", "error")) - before).toBe(1);
  });
});
