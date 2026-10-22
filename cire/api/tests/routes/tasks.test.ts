import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, guests, taskAssignees, tasks, weddingHosts } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import type { CloseTargets, HubNamespace } from "@shared/realtime/server";
import { eq, sql } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, DEV_OWNER_SEAT_ID, seedDb } from "../../src/db/setup";
import { CHECKLIST_TEMPLATES } from "../../src/lib/checklist-templates";
import { CIRE_METRICS } from "../../src/metrics";
import { appRequest, failStatements, jsonBody, recordStatements, setTier } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const HELPER = "usr_helper";
const STRANGER = "usr_stranger";
/** The sample wedding's first seeded event, which `seedDb` inserts. */
const SEED_EVENT = "9f7a2c14-1b3d-4e5f-8a01-000000000001";
/** A seat on the other wedding, so never assignable on the bootstrap one. */
const OTHER_SEAT = "whost_other_editor";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** The app's options here: a task-write limit of its own per app, far above
 *  anything a test sends, so no test spends another's. */
const appOptions = () => ({
  osnTestKey: auth.key,
  taskWriteLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
});

function buildApp(tier: "ivory" | "gold" | "crimson" = "gold") {
  return createApp(buildDb(tier), appOptions());
}

/** The checklist is a Gold module, so every wedding here is on it unless a test
 *  says otherwise. */
function buildDb(tier: "ivory" | "gold" | "crimson") {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts)
    .values({
      id: "whost_editor",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: EDITOR,
      addedByOsnProfileId: OWNER,
      role: "editor",
      createdAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values({
      id: "whost_viewer",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: VIEWER,
      addedByOsnProfileId: OWNER,
      role: "viewer",
      createdAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values({
      id: "whost_helper",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: HELPER,
      addedByOsnProfileId: OWNER,
      role: "helper",
      createdAt: now,
    })
    .run();
  insertWedding(db, {
    id: "wed_other",
    slug: "other-wedding",
    displayName: "Other",
    createdAt: now,
    updatedAt: now,
    owners: ["usr_bob"],
  });
  db.insert(weddingHosts)
    .values({
      id: OTHER_SEAT,
      weddingId: "wed_other",
      osnProfileId: EDITOR,
      addedByOsnProfileId: "usr_bob",
      role: "editor",
      createdAt: now,
    })
    .run();
  setTier(db, BOOTSTRAP_WEDDING_ID, tier);
  setTier(db, "wed_other", "gold");
  return db;
}
type App = ReturnType<typeof buildApp>;

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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/tasks`;
const CREATE = { title: "Book venue", timeframeBucket: "12m" };

describe("tasks routes", () => {
  it("401 without a token", async () => {
    expect((await req(buildApp(), "GET", base, undefined)).status).toBe(401);
  });

  it("member (viewer) may read", async () => {
    expect((await req(buildApp(), "GET", base, VIEWER)).status).toBe(200);
  });

  it("viewer may NOT create (403 read_only_role)", async () => {
    const res = await req(buildApp(), "POST", base, VIEWER, CREATE);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("read_only_role");
  });

  it("stranger is forbidden", async () => {
    expect((await req(buildApp(), "GET", base, STRANGER)).status).toBe(403);
  });

  // Every task's holders are seat ids of the whole wedding; a helper may be
  // scoped to its own rows, so the checklist read stays behind the member gate.
  it("refuses the checklist to a helper, even one that holds a task", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const created = await req(app, "POST", base, EDITOR, CREATE);
    const { task } = (await created.json()) as { task: { id: string } };
    expect(
      (await req(app, "PUT", `${base}/${task.id}/assignees/whost_helper`, EDITOR)).status,
    ).toBe(200);

    const res = await req(app, "GET", base, HELPER);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "forbidden" });
  });

  // The portal reads the checklist with the session cookie, and the seat it
  // names as the reader's comes from that cookie's account.
  it("reads the checklist on the session cookie, naming the caller's seat, and refuses a dead one", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const read = (cookie: string) => appRequest(app, base, { headers: { cookie } });

    const live = await read(`cire_org_session=${await seedOrganiserSession(db, VIEWER)}`);
    expect(live.status).toBe(200);
    expect(((await live.json()) as { viewerHostId: string }).viewerHostId).toBe("whost_viewer");
    const dead = await read("cire_org_session=not-a-live-session-token");
    expect(dead.status).toBe(401);
    expect(await dead.json()).not.toHaveProperty("tasks");
  });

  it("editor creates, lists, patches (done), and deletes", async () => {
    const app = buildApp();
    const created = await req(app, "POST", base, EDITOR, CREATE);
    expect(created.status).toBe(200);
    const { task } = (await created.json()) as { task: { id: string; status: string } };
    expect(task.status).toBe("open");

    const listed = await req(app, "GET", base, EDITOR);
    expect(((await listed.json()) as { tasks: unknown[] }).tasks.length).toBe(1);

    const patched = await req(app, "PATCH", `${base}/${task.id}`, EDITOR, { status: "done" });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { task: { status: string } }).task.status).toBe("done");

    const del = await req(app, "DELETE", `${base}/${task.id}`, EDITOR);
    expect(del.status).toBe(200);
  });

  it("400 on an unknown bucket", async () => {
    const res = await req(buildApp(), "POST", base, EDITOR, { title: "x", timeframeBucket: "5m" });
    expect(res.status).toBe(400);
  });

  it("404 patching a task under the wrong wedding (tenancy)", async () => {
    const app = buildApp();
    const created = await req(app, "POST", base, EDITOR, CREATE);
    const { task } = (await created.json()) as { task: { id: string } };
    // usr_bob owns wed_other; patch that task id under wed_other → task not found there.
    const otherBase = `/api/organiser/weddings/wed_other/tasks/${task.id}`;
    const res = await req(app, "PATCH", otherBase, "usr_bob", { status: "done" });
    expect(res.status).toBe(404);
  });
});

describe("the checklist is a Gold module", () => {
  const paymentRequired = { error: "payment_required", tier: "gold" };

  it("answers 402 to every route on an Ivory wedding, the read included", async () => {
    const app = buildApp("ivory");
    const calls: [string, string, string, unknown?][] = [
      ["GET", base, VIEWER],
      ["GET", base, OWNER],
      ["POST", base, EDITOR, CREATE],
      ["PATCH", `${base}/reorder`, EDITOR, { order: [] }],
      ["PATCH", `${base}/tsk_x`, EDITOR, { title: "x" }],
      ["PUT", `${base}/tsk_x/assignees/whost_helper`, EDITOR],
      ["DELETE", `${base}/tsk_x/assignees/whost_helper`, EDITOR],
      ["DELETE", `${base}/tsk_x`, OWNER],
    ];
    for (const [method, path, caller, body] of calls) {
      const res = await req(app, method, path, caller, body);
      expect(res.status, `${method} ${path}`).toBe(402);
      expect(await jsonBody(res)).toEqual(paymentRequired);
    }
  });

  it("opens on Gold and on Crimson", async () => {
    for (const tier of ["gold", "crimson"] as const) {
      expect((await req(buildApp(tier), "GET", base, VIEWER)).status, tier).toBe(200);
    }
  });

  it("answers the role refusal first: 401, then 403, before 402", async () => {
    const app = buildApp("ivory");
    expect((await req(app, "GET", base, undefined)).status).toBe(401);
    expect((await req(app, "GET", base, STRANGER)).status).toBe(403);
    const viewerWrite = await req(app, "POST", base, VIEWER, CREATE);
    expect(viewerWrite.status).toBe(403);
    expect(((await viewerWrite.json()) as { error: string }).error).toBe("read_only_role");
  });

  it("keeps a wedding's tasks while it is locked, and shows them again on Gold", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    expect((await req(app, "POST", base, EDITOR, CREATE)).status).toBe(200);
    setTier(db, BOOTSTRAP_WEDDING_ID, "ivory");
    expect((await req(app, "GET", base, OWNER)).status).toBe(402);
    setTier(db, BOOTSTRAP_WEDDING_ID, "gold");
    const res = await req(app, "GET", base, OWNER);
    expect(((await res.json()) as { tasks: unknown[] }).tasks.length).toBeGreaterThan(0);
  });
});

type TaskBody = { task: { id: string; assigneeHostIds: string[] } };
type ListBody = { tasks: TaskBody["task"][]; viewerHostId: string };

describe("the people holding a task", () => {
  const seatPath = (taskId: string, seat: string) => `${base}/${taskId}/assignees/${seat}`;

  async function createTask(app: App, title = "Carry the rings"): Promise<string> {
    const res = await req(app, "POST", base, EDITOR, { title, timeframeBucket: "day_of" });
    expect(res.status).toBe(200);
    const { task } = (await res.json()) as TaskBody;
    // Nobody holds a task the couple has just typed.
    expect(task.assigneeHostIds).toEqual([]);
    return task.id;
  }

  async function holdersOf(app: App, taskId: string): Promise<string[] | undefined> {
    const res = await req(app, "GET", base, OWNER);
    const { tasks: list } = (await res.json()) as ListBody;
    return list.find((t) => t.id === taskId)?.assigneeHostIds;
  }

  /** Add a seat the test goes on to depend on, and return the answer's holders. */
  async function add(app: App, taskId: string, seat: string, who = EDITOR): Promise<string[]> {
    const res = await req(app, "PUT", seatPath(taskId, seat), who);
    expect(res.status, seat).toBe(200);
    return ((await res.json()) as TaskBody).task.assigneeHostIds;
  }

  async function remove(app: App, taskId: string, seat: string, who = EDITOR): Promise<string[]> {
    const res = await req(app, "DELETE", seatPath(taskId, seat), who);
    expect(res.status, seat).toBe(200);
    return ((await res.json()) as TaskBody).task.assigneeHostIds;
  }

  const rowsFor = (db: ReturnType<typeof buildDb>, taskId: string) =>
    db
      .select({ hostId: taskAssignees.hostId })
      .from(taskAssignees)
      .where(eq(taskAssignees.taskId, taskId))
      .all()
      .map((r) => r.hostId)
      .toSorted();

  const counted = (action: string, result: string) =>
    counterValue(CIRE_METRICS.taskAssignmentChanged, { action, result });

  // ── Refusals ──────────────────────────────────────────────────────────────

  it("422s a seat of another wedding, a guest id, a task id and an id that names nothing, and writes nothing", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    await add(app, id, "whost_helper");
    const guestId = db.select({ id: guests.id }).from(guests).limit(1).all()[0]!.id;
    const before = await counted("add", "assignee_not_in_wedding");

    for (const stranger of [OTHER_SEAT, guestId, "whost_nobody", id, "w".repeat(64)]) {
      const res = await req(app, "PUT", seatPath(id, stranger), EDITOR);
      expect(res.status, stranger).toBe(422);
      expect(await jsonBody(res)).toEqual({ error: "assignee_not_in_wedding" });
    }
    expect(await holdersOf(app, id)).toEqual(["whost_helper"]);
    expect(rowsFor(db, id)).toEqual(["whost_helper"]);
    expect((await counted("add", "assignee_not_in_wedding")) - before).toBe(5);
  });

  it("400s a seat id past 64 characters, and routes no empty one, writing nothing", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    await add(app, id, "whost_helper");
    const overLong = "w".repeat(65);

    for (const method of ["PUT", "DELETE"]) {
      const res = await req(app, method, seatPath(id, overLong), EDITOR);
      expect(res.status, method).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
      // An empty seat id matches no route at all.
      const empty = await req(app, method, seatPath(id, ""), EDITOR);
      expect(empty.status, method).toBe(404);
    }
    expect(rowsFor(db, id)).toEqual(["whost_helper"]);
  });

  it("404s a task of another wedding and a missing one, for adding and removing, and leaves the task alone", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    await add(app, id, "whost_viewer");
    const addedBefore = await counted("add", "task_not_found");
    const removedBefore = await counted("remove", "task_not_found");

    // usr_bob owns wed_other: the task id is real, but not that wedding's —
    // with a seat of wed_other, so only the task decides the answer.
    const foreign = `/api/organiser/weddings/wed_other/tasks/${id}/assignees`;
    for (const [method, path, caller] of [
      ["PUT", `${foreign}/${OTHER_SEAT}`, "usr_bob"],
      ["DELETE", `${foreign}/whost_viewer`, "usr_bob"],
      ["PUT", seatPath("tsk_missing", "whost_helper"), EDITOR],
      ["DELETE", seatPath("tsk_missing", "whost_helper"), EDITOR],
    ] as const) {
      const res = await req(app, method, path, caller);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "task_not_found" });
    }
    expect(rowsFor(db, id)).toEqual(["whost_viewer"]);
    expect((await counted("add", "task_not_found")) - addedBefore).toBe(2);
    expect((await counted("remove", "task_not_found")) - removedBefore).toBe(2);
  });

  it("refuses a viewer, a helper, a stranger and no token, adding or removing, and changes nothing", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    await add(app, id, "whost_viewer");

    for (const [method, seat] of [
      ["PUT", "whost_helper"],
      ["DELETE", "whost_viewer"],
    ] as const) {
      const viewer = await req(app, method, seatPath(id, seat), VIEWER);
      expect(viewer.status, method).toBe(403);
      expect(await jsonBody(viewer)).toMatchObject({ error: "read_only_role" });
      for (const caller of [HELPER, STRANGER]) {
        const res = await req(app, method, seatPath(id, seat), caller);
        expect(res.status, `${method} ${caller}`).toBe(403);
        expect(await jsonBody(res), caller).toMatchObject({ error: "forbidden" });
      }
      expect((await req(app, method, seatPath(id, seat), undefined)).status, method).toBe(401);
    }
    expect(rowsFor(db, id)).toEqual(["whost_viewer"]);
  });

  // The portal reaches these routes with the organiser session cookie, so the
  // cookie path has to hold for them, not only the bearer the tests above send.
  it("accepts the session cookie, and refuses a dead one without writing", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    const send = (method: string, cookie: string, seat: string) =>
      appRequest(app, seatPath(id, seat), { method, headers: { cookie } });

    const live = `cire_org_session=${await seedOrganiserSession(db, EDITOR)}`;
    const dead = "cire_org_session=not-a-live-session-token";
    expect((await send("PUT", live, "whost_helper")).status).toBe(200);
    expect((await send("PUT", dead, "whost_viewer")).status).toBe(401);
    expect((await send("DELETE", dead, "whost_helper")).status).toBe(401);
    expect(rowsFor(db, id)).toEqual(["whost_helper"]);
    expect((await send("DELETE", live, "whost_helper")).status).toBe(200);
    expect(rowsFor(db, id)).toEqual([]);
  });

  // Only the assignee routes check that a seat is the wedding's, so no other
  // task route may write one: creating or editing a task drops the field.
  it("writes no holder sent to the task create or edit route", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    await add(app, id, "whost_helper");

    const patched = await req(app, "PATCH", `${base}/${id}`, EDITOR, {
      title: "Carry both rings",
      assigneeHostIds: [OTHER_SEAT],
      assignedHostId: OTHER_SEAT,
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as TaskBody).task.assigneeHostIds).toEqual(["whost_helper"]);
    expect(rowsFor(db, id)).toEqual(["whost_helper"]);

    const created = await req(app, "POST", base, EDITOR, {
      title: "Mind the cake",
      timeframeBucket: "day_of",
      assigneeHostIds: ["whost_helper"],
      assignedHostId: "whost_helper",
    });
    expect(created.status).toBe(200);
    const { task } = (await created.json()) as TaskBody;
    expect(task.assigneeHostIds).toEqual([]);
    expect(rowsFor(db, task.id)).toEqual([]);

    // Nor into the single-assignee column the database still holds, which
    // this API never names.
    expect(
      db.$client
        .query("SELECT id, assigned_host_id FROM tasks WHERE id IN (?, ?) ORDER BY id")
        .all(...[id, task.id].toSorted()),
    ).toEqual([id, task.id].toSorted().map((taskId) => ({ id: taskId, assigned_host_id: null })));
  });

  it("answers 500 and writes nothing when the database fails the write", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    await add(app, id, "whost_viewer");
    const addErrors = await counted("add", "error");
    const removeErrors = await counted("remove", "error");

    for (const [method, seat, statement] of [
      ["PUT", "whost_helper", 'insert into "task_assignees"'],
      ["DELETE", "whost_viewer", 'delete from "task_assignees"'],
    ] as const) {
      const failure = failStatements(db, (text) => text.startsWith(statement));
      const res = await req(app, method, seatPath(id, seat), EDITOR);
      expect(failure.failed(), method).toBe(1);
      expect(res.status, method).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "Internal error" });
      failure.restore();
    }
    expect(rowsFor(db, id)).toEqual(["whost_viewer"]);
    expect((await counted("add", "error")) - addErrors).toBe(1);
    expect((await counted("remove", "error")) - removeErrors).toBe(1);
  });

  // ── What the routes do ────────────────────────────────────────────────────

  it("adds and removes seats, and every answer and the list carry them in the order they were added", async () => {
    const app = buildApp();
    const id = await createTask(app);
    const addedBefore = await counted("add", "ok");
    const removedBefore = await counted("remove", "ok");

    expect(await add(app, id, "whost_helper")).toEqual(["whost_helper"]);
    expect(await add(app, id, "whost_viewer", OWNER)).toEqual(["whost_helper", "whost_viewer"]);
    expect(await holdersOf(app, id)).toEqual(["whost_helper", "whost_viewer"]);

    expect(await remove(app, id, "whost_helper")).toEqual(["whost_viewer"]);
    // Added again, a seat goes to the end.
    expect(await add(app, id, "whost_helper")).toEqual(["whost_viewer", "whost_helper"]);
    expect(await holdersOf(app, id)).toEqual(["whost_viewer", "whost_helper"]);

    expect((await counted("add", "ok")) - addedBefore).toBe(3);
    expect((await counted("remove", "ok")) - removedBefore).toBe(1);
  });

  it("adds any seat of the wedding, whatever its role", async () => {
    const app = buildApp();
    const id = await createTask(app);
    const seats = [DEV_OWNER_SEAT_ID, "whost_editor", "whost_viewer", "whost_helper"];
    for (const seat of seats) await add(app, id, seat);
    expect(await holdersOf(app, id)).toEqual(seats);
  });

  it("answers 200 unchanged to adding a seat the task holds, and keeps its place", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    await add(app, id, "whost_helper");
    await add(app, id, "whost_viewer");
    const before = await counted("add", "unchanged");

    expect(await add(app, id, "whost_helper")).toEqual(["whost_helper", "whost_viewer"]);
    expect(rowsFor(db, id)).toEqual(["whost_helper", "whost_viewer"]);
    expect((await counted("add", "unchanged")) - before).toBe(1);
  });

  it("answers 200 unchanged to removing a seat the task does not hold", async () => {
    const app = buildApp();
    const id = await createTask(app);
    await add(app, id, "whost_helper");
    const before = await counted("remove", "unchanged");

    for (const seat of ["whost_viewer", "whost_nobody", OTHER_SEAT]) {
      expect(await remove(app, id, seat), seat).toEqual(["whost_helper"]);
    }
    expect((await counted("remove", "unchanged")) - before).toBe(3);
  });

  it("keeps both seats when two people add different seats at once", async () => {
    const app = buildApp();
    const id = await createTask(app);
    const [byEditor, byOwner] = await Promise.all([
      req(app, "PUT", seatPath(id, "whost_helper"), EDITOR),
      req(app, "PUT", seatPath(id, "whost_viewer"), OWNER),
    ]);
    expect([byEditor.status, byOwner.status]).toEqual([200, 200]);
    expect(((await byEditor.json()) as TaskBody).task.assigneeHostIds).toContain("whost_helper");
    expect(((await byOwner.json()) as TaskBody).task.assigneeHostIds).toContain("whost_viewer");
    expect((await holdersOf(app, id))?.toSorted()).toEqual(["whost_helper", "whost_viewer"]);
  });

  it("keeps the order seats were added in when they were added in the same second", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    // Written straight in, so the second is the same for all three; the seat
    // ids run against the order they were added in.
    const second = new Date();
    const order = ["whost_viewer", "whost_helper", "whost_editor"];
    for (const hostId of order) {
      db.insert(taskAssignees)
        .values({ taskId: id, hostId, weddingId: BOOTSTRAP_WEDDING_ID, assignedAt: second })
        .run();
    }
    expect(await holdersOf(app, id)).toEqual(order);
    const patched = await req(app, "PATCH", `${base}/${id}`, EDITOR, {});
    expect(((await patched.json()) as TaskBody).task.assigneeHostIds).toEqual(order);
    expect(await add(app, id, DEV_OWNER_SEAT_ID)).toEqual([...order, DEV_OWNER_SEAT_ID]);
    expect(await remove(app, id, "whost_helper")).toEqual([
      "whost_viewer",
      "whost_editor",
      DEV_OWNER_SEAT_ID,
    ]);
  });

  // The index the checklist read uses happens to return holders in the order
  // they were added; the order must not rest on which index the database picks.
  it("keeps the order seats were added in, whichever index the database reads them through", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const id = await createTask(app);
    // Written out of order: by row, editor, viewer, helper; by seat id, editor,
    // helper, viewer; by when they were added, viewer, helper, editor.
    const second = Math.floor(Date.now() / 1000);
    for (const [hostId, offset] of [
      ["whost_editor", 2],
      ["whost_viewer", 0],
      ["whost_helper", 1],
    ] as const) {
      db.insert(taskAssignees)
        .values({
          taskId: id,
          hostId,
          weddingId: BOOTSTRAP_WEDDING_ID,
          assignedAt: new Date((second + offset) * 1000),
        })
        .run();
    }
    const added = ["whost_viewer", "whost_helper", "whost_editor"];
    const answers = async () => {
      const patched = await req(app, "PATCH", `${base}/${id}`, EDITOR, {});
      return [await holdersOf(app, id), ((await patched.json()) as TaskBody).task.assigneeHostIds];
    };

    expect(await answers()).toEqual([added, added]);
    db.run(sql`DROP INDEX task_assignees_wedding_task_idx`);
    expect(await answers()).toEqual([added, added]);
  });

  it("keeps a task's holders when it is ticked off and opened again", async () => {
    const app = buildApp();
    const id = await createTask(app);
    await add(app, id, "whost_helper");
    await add(app, id, "whost_viewer");

    for (const status of ["done", "open"]) {
      const res = await req(app, "PATCH", `${base}/${id}`, EDITOR, { status });
      expect(res.status, status).toBe(200);
      expect(((await res.json()) as TaskBody).task.assigneeHostIds, status).toEqual([
        "whost_helper",
        "whost_viewer",
      ]);
    }
    expect(await holdersOf(app, id)).toEqual(["whost_helper", "whost_viewer"]);
  });

  it("takes only the removed seat off its tasks, and keeps the tasks", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const shared = await createTask(app);
    const alone = await createTask(app, "Mind the cake");
    await add(app, shared, "whost_helper");
    await add(app, shared, "whost_viewer");
    await add(app, alone, "whost_helper");

    const removed = await req(
      app,
      "DELETE",
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/hosts/${HELPER}`,
      OWNER,
    );
    expect(removed.status).toBe(200);
    expect(await holdersOf(app, shared)).toEqual(["whost_viewer"]);
    expect(await holdersOf(app, alone)).toEqual([]);
    expect(db.select().from(tasks).where(eq(tasks.id, alone)).all()).toHaveLength(1);
  });

  it("takes a seat that leaves the wedding off its tasks, and keeps the tasks", async () => {
    const app = buildApp();
    const id = await createTask(app);
    await add(app, id, "whost_viewer");
    await add(app, id, "whost_helper");

    const left = await req(
      app,
      "DELETE",
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/hosts/me`,
      VIEWER,
    );
    expect(left.status).toBe(200);
    expect(await holdersOf(app, id)).toEqual(["whost_helper"]);
  });

  it("keeps the last owner's tasks when their leave is refused", async () => {
    const app = buildApp();
    const id = await createTask(app);
    await add(app, id, DEV_OWNER_SEAT_ID);

    const left = await req(
      app,
      "DELETE",
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/hosts/me`,
      OWNER,
    );
    expect(left.status).toBe(409);
    expect(await holdersOf(app, id)).toEqual([DEV_OWNER_SEAT_ID]);
  });

  it("takes a deleted task's holders with it, and no other task's", async () => {
    const db = buildDb("gold");
    const app = createApp(db, appOptions());
    const gone = await createTask(app);
    const kept = await createTask(app, "Mind the cake");
    await add(app, gone, "whost_helper");
    await add(app, gone, "whost_viewer");
    await add(app, kept, "whost_helper");

    expect((await req(app, "DELETE", `${base}/${gone}`, EDITOR)).status).toBe(200);
    expect(rowsFor(db, gone)).toEqual([]);
    expect(rowsFor(db, kept)).toEqual(["whost_helper"]);
  });

  it("tells each reader of the checklist which seat is theirs", async () => {
    const app = buildApp();
    for (const [caller, seat] of [
      [OWNER, DEV_OWNER_SEAT_ID],
      [EDITOR, "whost_editor"],
      [VIEWER, "whost_viewer"],
    ] as const) {
      const res = await req(app, "GET", base, caller);
      expect(res.status, caller).toBe(200);
      expect(((await res.json()) as ListBody).viewerHostId, caller).toBe(seat);
    }
  });
});

// ── A task's run time ───────────────────────────────────────────────────────

/** A task as every answer carries its time. */
type TimedTask = {
  id: string;
  title: string;
  runAt: string | null;
  runTimezone: string | null;
  eventId: string | null;
  runOffsetMinutes: number | null;
  anchored: boolean;
  eventRemoved: boolean;
};

describe("a task's run time", () => {
  const CEREMONY = "evt_rt_ceremony";
  const THEIRS = "evt_rt_theirs";

  /** The bootstrap wedding with a ceremony at 15:00 Sydney on a June day (AEST,
   *  +10:00), and the other wedding with an event of its own. */
  function build() {
    const db = buildDb("gold");
    db.insert(events)
      .values([
        {
          id: CEREMONY,
          weddingId: BOOTSTRAP_WEDDING_ID,
          slug: "rt-ceremony",
          name: "Ceremony",
          startAt: "2099-06-20T15:00:00+10:00",
          endAt: "",
          timezone: "Australia/Sydney",
        },
        {
          id: THEIRS,
          weddingId: "wed_other",
          slug: "rt-theirs",
          name: "Their ceremony",
          startAt: "2099-06-20T15:00:00+10:00",
          endAt: "",
          timezone: "Australia/Sydney",
        },
      ])
      .run();
    return { db, app: createApp(db, appOptions()) };
  }

  async function newTask(app: App): Promise<string> {
    const res = await req(app, "POST", base, EDITOR, {
      title: "Bring the rings",
      timeframeBucket: "day_of",
    });
    expect(res.status).toBe(200);
    const { task } = (await res.json()) as { task: TimedTask };
    expect(task).toMatchObject({
      runAt: null,
      runTimezone: null,
      eventId: null,
      runOffsetMinutes: null,
      anchored: false,
      eventRemoved: false,
    });
    return task.id;
  }

  const patch = (app: App, id: string, body: unknown) =>
    req(app, "PATCH", `${base}/${id}`, EDITOR, body);

  /** The row's five run-time columns, as stored. */
  const stored = (db: ReturnType<typeof buildDb>, id: string) =>
    db
      .select({
        title: tasks.title,
        runAt: tasks.runAt,
        runTimezone: tasks.runTimezone,
        eventId: tasks.eventId,
        runOffsetMinutes: tasks.runOffsetMinutes,
        eventRemovedAt: tasks.eventRemovedAt,
      })
      .from(tasks)
      .where(eq(tasks.id, id))
      .all()[0];

  const UNTIMED = {
    runAt: null,
    runTimezone: null,
    eventId: null,
    runOffsetMinutes: null,
    eventRemovedAt: null,
  };

  const counted = (kind: string, result: string) =>
    counterValue(CIRE_METRICS.taskRunTimeChanged, { kind, result });

  // ── Refusals ──────────────────────────────────────────────────────────────

  it("400s a run time that cannot say what it means, and writes nothing", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    for (const runTime of [
      { kind: "fixed", at: "2099-06-20T15:00" },
      { kind: "fixed", timezone: "Australia/Sydney" },
      { kind: "offset", eventId: CEREMONY },
      { kind: "offset", offsetMinutes: -30 },
      { kind: "clock", eventId: CEREMONY },
      { kind: "clock", at: "2099-06-20T14:30" },
      { kind: "later" },
      { at: "2099-06-20T15:00", timezone: "Australia/Sydney" },
      "2099-06-20T15:00",
      { kind: "offset", eventId: "", offsetMinutes: 0 },
      { kind: "offset", eventId: "e".repeat(65), offsetMinutes: 0 },
    ]) {
      const res = await patch(app, id, { runTime, title: "Changed" });
      expect(res.status, JSON.stringify(runTime)).toBe(400);
    }
    expect(stored(db, id)).toEqual({ title: "Bring the rings", ...UNTIMED });
  });

  it("400s a zone that is not a real IANA zone, a fixed offset included", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    for (const timezone of ["+10:00", "UTC+10", "GMT+10", "Mars/Base", "", "A".repeat(65)]) {
      const res = await patch(app, id, {
        runTime: { kind: "fixed", at: "2099-06-20T15:00", timezone },
      });
      expect(res.status, timezone).toBe(400);
    }
    expect(stored(db, id)).toEqual({ title: "Bring the rings", ...UNTIMED });
  });

  it("400s a date and time that does not exist or is not one", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    for (const at of ["2099-13-40T99:99", "tomorrow", "2099-06-20", "15:00", ""]) {
      for (const runTime of [
        { kind: "fixed", at, timezone: "Australia/Sydney" },
        { kind: "clock", eventId: CEREMONY, at },
      ]) {
        expect((await patch(app, id, { runTime })).status, `${runTime.kind} ${at}`).toBe(400);
      }
    }
    expect(stored(db, id)).toEqual({ title: "Bring the rings", ...UNTIMED });
  });

  it("400s an offset that is not whole minutes or is more than a day from the start", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    for (const offsetMinutes of [0.5, 1441, -1441, Number.MAX_SAFE_INTEGER, "30", null]) {
      const res = await patch(app, id, {
        runTime: { kind: "offset", eventId: CEREMONY, offsetMinutes },
      });
      expect(res.status, String(offsetMinutes)).toBe(400);
    }
    expect(stored(db, id)).toEqual({ title: "Bring the rings", ...UNTIMED });
  });

  it("422s a link to another wedding's event, a task, a guest or nothing, and writes no field of the patch", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const other = await newTask(app);
    const guestId = db.select({ id: guests.id }).from(guests).limit(1).all()[0]!.id;
    const before = await counted("offset", "event_not_in_wedding");
    const beforeClock = await counted("clock", "event_not_in_wedding");

    for (const eventId of [THEIRS, other, guestId, "evt_nope"]) {
      const offset = await patch(app, id, {
        title: "Changed",
        runTime: { kind: "offset", eventId, offsetMinutes: -30 },
      });
      expect(offset.status, eventId).toBe(422);
      expect(await jsonBody(offset)).toEqual({ error: "event_not_in_wedding" });
      const clock = await patch(app, id, {
        title: "Changed",
        runTime: { kind: "clock", eventId, at: "2099-06-20T14:30" },
      });
      expect(clock.status, eventId).toBe(422);
      expect(await jsonBody(clock)).toEqual({ error: "event_not_in_wedding" });
    }
    expect(stored(db, id)).toEqual({ title: "Bring the rings", ...UNTIMED });
    expect((await counted("offset", "event_not_in_wedding")) - before).toBe(4);
    expect((await counted("clock", "event_not_in_wedding")) - beforeClock).toBe(4);
  });

  it("404s a missing task before it judges the event, and counts it as one", async () => {
    const { app } = build();
    const offsetBefore = await counted("offset", "task_not_found");
    const clockBefore = await counted("clock", "task_not_found");
    for (const runTime of [
      { kind: "offset", eventId: THEIRS, offsetMinutes: 0 },
      { kind: "clock", eventId: THEIRS, at: "2099-06-20T14:30" },
      { kind: "offset", eventId: CEREMONY, offsetMinutes: 0 },
      { kind: "clock", eventId: CEREMONY, at: "2099-06-20T14:30" },
    ]) {
      const res = await patch(app, "tsk_nope", { runTime });
      expect(res.status, JSON.stringify(runTime)).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "task_not_found" });
    }
    expect((await counted("offset", "task_not_found")) - offsetBefore).toBe(2);
    expect((await counted("clock", "task_not_found")) - clockBefore).toBe(2);
  });

  it("422s a clock time more than a day from the event's start, and writes nothing", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const before = await counted("clock", "out_of_range");
    for (const at of ["2099-06-21T15:01", "2099-06-19T14:59", "2098-06-20T15:00"]) {
      const res = await patch(app, id, {
        title: "Changed",
        runTime: { kind: "clock", eventId: CEREMONY, at },
      });
      expect(res.status, at).toBe(422);
      expect(await jsonBody(res)).toEqual({ error: "run_time_out_of_range" });
    }
    expect(stored(db, id)).toEqual({ title: "Bring the rings", ...UNTIMED });
    expect((await counted("clock", "out_of_range")) - before).toBe(3);
  });

  it("takes an offset and a clock time exactly a day either side of the event's start", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const cases = [
      [{ kind: "offset", offsetMinutes: -1440 }, "2099-06-19T15:00:00+10:00", -1440],
      [{ kind: "offset", offsetMinutes: 1440 }, "2099-06-21T15:00:00+10:00", 1440],
      [{ kind: "clock", at: "2099-06-21T15:00" }, "2099-06-21T15:00:00+10:00", 1440],
      [{ kind: "clock", at: "2099-06-19T15:00" }, "2099-06-19T15:00:00+10:00", -1440],
    ] as const;
    for (const [runTime, runAt, runOffsetMinutes] of cases) {
      const res = await patch(app, id, { runTime: { ...runTime, eventId: CEREMONY } });
      expect(res.status, JSON.stringify(runTime)).toBe(200);
      expect(((await res.json()) as { task: TimedTask }).task).toMatchObject({
        runAt,
        runOffsetMinutes,
        anchored: true,
      });
      expect(stored(db, id)?.runOffsetMinutes).toBe(runOffsetMinutes);
    }
  });

  // ── Writes ────────────────────────────────────────────────────────────────

  it("stamps a fixed time with its own zone's offset for that date, ignoring any offset sent", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const before = await counted("fixed", "ok");

    const winter = await patch(app, id, {
      runTime: { kind: "fixed", at: "2099-06-20T15:00+05:30", timezone: "Australia/Sydney" },
    });
    expect(winter.status).toBe(200);
    expect(((await winter.json()) as { task: TimedTask }).task).toMatchObject({
      runAt: "2099-06-20T15:00:00+10:00",
      runTimezone: "Australia/Sydney",
      eventId: null,
      runOffsetMinutes: null,
      anchored: false,
      eventRemoved: false,
    });

    const summer = await patch(app, id, {
      runTime: { kind: "fixed", at: "2099-12-20T15:00", timezone: "Australia/Sydney" },
    });
    expect(summer.status).toBe(200);
    expect(stored(db, id)).toEqual({
      title: "Bring the rings",
      ...UNTIMED,
      runAt: "2099-12-20T15:00:00+11:00",
      runTimezone: "Australia/Sydney",
    });
    expect((await counted("fixed", "ok")) - before).toBe(2);
  });

  it("stores a zone as it was sent, an alias included", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const res = await patch(app, id, {
      runTime: { kind: "fixed", at: "2099-06-20T12:00", timezone: "Asia/Calcutta" },
    });
    expect(res.status).toBe(200);
    expect(stored(db, id)).toMatchObject({
      runAt: "2099-06-20T12:00:00+05:30",
      runTimezone: "Asia/Calcutta",
    });
  });

  it("links a task by an offset, and answers the time it derives in the event's zone", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const res = await patch(app, id, {
      runTime: { kind: "offset", eventId: CEREMONY, offsetMinutes: -30 },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { task: TimedTask }).task).toMatchObject({
      runAt: "2099-06-20T14:30:00+10:00",
      runTimezone: "Australia/Sydney",
      eventId: CEREMONY,
      runOffsetMinutes: -30,
      anchored: true,
      eventRemoved: false,
    });
    // Only the link is stored: the time is derived on every read.
    expect(stored(db, id)).toEqual({
      title: "Bring the rings",
      ...UNTIMED,
      eventId: CEREMONY,
      runOffsetMinutes: -30,
    });
  });

  it("saves a clock time typed against an event as an offset from its start", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const res = await patch(app, id, {
      runTime: { kind: "clock", eventId: CEREMONY, at: "2099-06-20T16:15" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { task: TimedTask }).task).toMatchObject({
      runAt: "2099-06-20T16:15:00+10:00",
      runOffsetMinutes: 75,
      anchored: true,
    });
    expect(stored(db, id)).toMatchObject({ eventId: CEREMONY, runOffsetMinutes: 75, runAt: null });
  });

  it("replaces the whole run time each write: a link drops a fixed time, a fixed time drops a link, null drops both", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const fixed = { kind: "fixed", at: "2099-06-20T12:00", timezone: "Australia/Sydney" };
    const linked = { kind: "offset", eventId: CEREMONY, offsetMinutes: 10 };

    expect((await patch(app, id, { runTime: fixed })).status).toBe(200);
    expect((await patch(app, id, { runTime: linked })).status).toBe(200);
    expect(stored(db, id)).toEqual({
      title: "Bring the rings",
      ...UNTIMED,
      eventId: CEREMONY,
      runOffsetMinutes: 10,
    });

    // A key the kind does not take is ignored, never stored beside it.
    expect(
      (await patch(app, id, { runTime: { ...fixed, eventId: CEREMONY, offsetMinutes: 5 } })).status,
    ).toBe(200);
    expect(stored(db, id)).toEqual({
      title: "Bring the rings",
      ...UNTIMED,
      runAt: "2099-06-20T12:00:00+10:00",
      runTimezone: "Australia/Sydney",
    });

    expect((await patch(app, id, { runTime: linked })).status).toBe(200);
    const before = await counted("clear", "ok");
    expect((await patch(app, id, { runTime: null })).status).toBe(200);
    expect(stored(db, id)).toEqual({ title: "Bring the rings", ...UNTIMED });
    expect((await counted("clear", "ok")) - before).toBe(1);
  });

  it("drops the event-removed mark on any run-time write, and keeps it on any other", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const freeze = () =>
      db
        .update(tasks)
        .set({
          runAt: "2099-06-20T14:30:00+10:00",
          runTimezone: "Australia/Sydney",
          eventRemovedAt: new Date(),
        })
        .where(eq(tasks.id, id))
        .run();

    freeze();
    expect((await patch(app, id, { title: "Still frozen" })).status).toBe(200);
    expect(stored(db, id)?.eventRemovedAt).not.toBeNull();
    const kept = (await (await req(app, "GET", base, OWNER)).json()) as { tasks: TimedTask[] };
    expect(kept.tasks.find((t) => t.id === id)).toMatchObject({
      runAt: "2099-06-20T14:30:00+10:00",
      runTimezone: "Australia/Sydney",
      eventRemoved: true,
    });

    for (const runTime of [
      { kind: "offset", eventId: CEREMONY, offsetMinutes: 0 },
      { kind: "fixed", at: "2099-06-20T12:00", timezone: "Australia/Sydney" },
      null,
    ]) {
      freeze();
      const res = await patch(app, id, { runTime });
      expect(res.status, JSON.stringify(runTime)).toBe(200);
      expect(((await res.json()) as { task: TimedTask }).task.eventRemoved).toBe(false);
      expect(stored(db, id)?.eventRemovedAt).toBeNull();
    }
  });

  // ── Every answer carries the derived time ─────────────────────────────────

  it("answers a linked task's time on the list, the holder writes and the starter, and follows the event when it moves", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    expect(
      (await patch(app, id, { runTime: { kind: "offset", eventId: CEREMONY, offsetMinutes: -30 } }))
        .status,
    ).toBe(200);
    const want = { id, runAt: "2099-06-20T14:30:00+10:00", anchored: true, runOffsetMinutes: -30 };

    const list = (await (await req(app, "GET", base, VIEWER)).json()) as { tasks: TimedTask[] };
    expect(list.tasks.find((t) => t.id === id)).toMatchObject(want);

    const put = await req(app, "PUT", `${base}/${id}/assignees/whost_helper`, EDITOR);
    expect(((await put.json()) as { task: TimedTask }).task).toMatchObject(want);
    const del = await req(app, "DELETE", `${base}/${id}/assignees/whost_helper`, EDITOR);
    expect(((await del.json()) as { task: TimedTask }).task).toMatchObject(want);

    const key = CHECKLIST_TEMPLATES.starter[0]!.key;
    const starter = await req(app, "POST", `${base}/templates/starter`, EDITOR, { items: [key] });
    expect(starter.status).toBe(200);
    const applied = (await starter.json()) as { tasks: TimedTask[] };
    expect(applied.tasks.find((t) => t.id === id)).toMatchObject(want);
    // A seeded task starts untimed.
    expect(applied.tasks.filter((t) => t.id !== id).every((t) => t.runAt === null)).toBe(true);

    // The ceremony moves to Kolkata, a day later: the task goes with it.
    db.update(events)
      .set({ startAt: "2099-06-21T10:00:00+05:30", timezone: "Asia/Kolkata" })
      .where(eq(events.id, CEREMONY))
      .run();
    const moved = (await (await req(app, "GET", base, OWNER)).json()) as { tasks: TimedTask[] };
    expect(moved.tasks.find((t) => t.id === id)).toMatchObject({
      runAt: "2099-06-21T09:30:00+05:30",
      runTimezone: "Asia/Kolkata",
      anchored: true,
    });
  });

  it("reads each answer's linked events in the statement that reads its tasks", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    await patch(app, id, { runTime: { kind: "offset", eventId: CEREMONY, offsetMinutes: -30 } });
    const recorded = recordStatements(db);
    expect((await req(app, "GET", base, VIEWER)).status).toBe(200);
    expect((await req(app, "PUT", `${base}/${id}/assignees/whost_helper`, EDITOR)).status).toBe(
      200,
    );
    expect((await req(app, "DELETE", `${base}/${id}/assignees/whost_helper`, EDITOR)).status).toBe(
      200,
    );
    const key = CHECKLIST_TEMPLATES.starter[0]!.key;
    expect(
      (await req(app, "POST", `${base}/templates/starter`, EDITOR, { items: [key] })).status,
    ).toBe(200);
    const sqls = recorded.map((r) => r.sql.toLowerCase());
    // The list, both holder writes and the starter each read their tasks with
    // the events they link to, and never the events on their own.
    expect(
      sqls.filter((q) => q.startsWith("select") && q.includes('left join "events"')),
    ).toHaveLength(4);
    expect(sqls.filter((q) => /^select .* from "events"/.test(q))).toEqual([]);
  });

  it("reads a link no writer leaves, to another wedding's event, as untimed", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    db.update(tasks).set({ eventId: THEIRS, runOffsetMinutes: -30 }).where(eq(tasks.id, id)).run();
    const list = (await (await req(app, "GET", base, OWNER)).json()) as { tasks: TimedTask[] };
    expect(list.tasks.find((t) => t.id === id)).toMatchObject({
      runAt: null,
      eventId: null,
      anchored: false,
    });
  });

  it("answers 500, counts the failure and writes nothing when the database fails a run-time write", async () => {
    const { db, app } = build();
    const id = await newTask(app);
    const before = await counted("offset", "error");
    const failure = failStatements(db, (text) => text.startsWith('update "tasks"'));
    const res = await patch(app, id, {
      runTime: { kind: "offset", eventId: CEREMONY, offsetMinutes: 0 },
    });
    failure.restore();
    expect(res.status).toBe(500);
    expect(stored(db, id)).toEqual({ title: "Bring the rings", ...UNTIMED });
    expect((await counted("offset", "error")) - before).toBe(1);
  });
});

describe("task writes publish tasks-changed", () => {
  type Published = { name: string; signal: unknown; targets: CloseTargets };

  function recordingHub(rejects = false) {
    const publishes: Published[] = [];
    const hub: HubNamespace = {
      getByName: (name) => ({
        publish: async (signal, targets) => {
          publishes.push({ name, signal, targets });
          if (rejects) throw new Error("hub down");
          return 1;
        },
        fetch: async () => new Response(null, { status: 426 }),
      }),
    };
    return { hub, publishes };
  }

  function buildWithHub(
    tier: "ivory" | "gold" = "gold",
    rejects = false,
    taskWriteLimiter = createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  ) {
    const db = buildDb(tier);
    const { hub, publishes } = recordingHub(rejects);
    const app = createApp(db, { ...appOptions(), realtimeHub: hub, taskWriteLimiter });
    return { db, app, publishes };
  }

  const topic = `cire:wedding:${BOOTSTRAP_WEDDING_ID}`;
  /** What one accepted task write sends the hub: the topic, the kind and a
   *  time, nothing about the task, and nobody's socket closed. */
  const changed = (): Published => ({
    name: topic,
    signal: { topic, kind: "tasks-changed", at: expect.any(Number) },
    targets: { evict: [], revoke: [] },
  });

  async function newTask(app: App, title = "Book venue"): Promise<string> {
    const res = await req(app, "POST", base, EDITOR, { ...CREATE, title });
    expect(res.status).toBe(200);
    return ((await res.json()) as { task: { id: string } }).task.id;
  }

  const holderPath = (taskId: string, hostId: string) => `${base}/${taskId}/assignees/${hostId}`;

  it("after a create", async () => {
    const { app, publishes } = buildWithHub();
    await newTask(app);
    expect(publishes).toStrictEqual([changed()]);
    // The signal names the change, never the task.
    expect(JSON.stringify(publishes[0]!.signal)).not.toContain("Book venue");
  });

  it.each([
    ["an edit", { title: "Book the hall" }],
    ["a tick", { status: "done" }],
    ["an untick", { status: "open" }],
    [
      "a fixed time",
      { runTime: { kind: "fixed", at: "2099-06-20T15:00", timezone: "Australia/Sydney" } },
    ],
    ["a cleared time", { runTime: null }],
    // The sample wedding's first seeded event (cire/db/seed/data/events.ts).
    ["a link", { runTime: { kind: "offset", eventId: SEED_EVENT, offsetMinutes: -30 } }],
    ["a clock time", { runTime: { kind: "clock", eventId: SEED_EVENT, at: "2026-10-31T09:30" } }],
  ])("after %s", async (_label, patch) => {
    const { app, publishes } = buildWithHub();
    const id = await newTask(app);
    const res = await req(app, "PATCH", `${base}/${id}`, EDITOR, patch);
    expect(res.status).toBe(200);
    expect(publishes).toStrictEqual([changed(), changed()]);
  });

  it("after a delete", async () => {
    const { app, publishes } = buildWithHub();
    const id = await newTask(app);
    expect((await req(app, "DELETE", `${base}/${id}`, EDITOR)).status).toBe(200);
    expect(publishes).toStrictEqual([changed(), changed()]);
  });

  it("after a reorder", async () => {
    const { app, publishes } = buildWithHub();
    const first = await newTask(app, "One");
    const second = await newTask(app, "Two");
    const res = await req(app, "PATCH", `${base}/reorder`, EDITOR, {
      timeframeBucket: "12m",
      orderedIds: [second, first],
    });
    expect(res.status).toBe(200);
    expect(publishes).toStrictEqual([changed(), changed(), changed()]);
  });

  it("after the starter adds tasks, and not when it adds none", async () => {
    const { app, publishes } = buildWithHub();
    const key = CHECKLIST_TEMPLATES.starter[0]!.key;
    const apply = () => req(app, "POST", `${base}/templates/starter`, EDITOR, { items: [key] });
    expect((await apply()).status).toBe(200);
    expect(publishes).toStrictEqual([changed()]);
    // The item is on the checklist already, so the apply adds nothing.
    expect((await apply()).status).toBe(200);
    expect(publishes).toStrictEqual([changed()]);
  });

  it("after a holder is put on and taken off, and not when either changes nothing", async () => {
    const { app, publishes } = buildWithHub();
    const id = await newTask(app);
    expect((await req(app, "PUT", holderPath(id, "whost_helper"), EDITOR)).status).toBe(200);
    expect(publishes).toHaveLength(2);
    // Already on: answered as it is, and nobody is told.
    expect((await req(app, "PUT", holderPath(id, "whost_helper"), EDITOR)).status).toBe(200);
    expect(publishes).toHaveLength(2);
    expect((await req(app, "DELETE", holderPath(id, "whost_helper"), EDITOR)).status).toBe(200);
    expect(publishes).toHaveLength(3);
    // Not on: the same.
    expect((await req(app, "DELETE", holderPath(id, "whost_helper"), EDITOR)).status).toBe(200);
    expect(publishes).toStrictEqual([changed(), changed(), changed()]);
  });

  it("never for a refused write", async () => {
    const { app, publishes } = buildWithHub();
    const id = await newTask(app);
    publishes.length = 0;
    const refusals: [string, string, string | undefined, unknown, number][] = [
      ["POST", base, EDITOR, { title: "" }, 400],
      ["POST", base, VIEWER, CREATE, 403],
      ["POST", base, HELPER, CREATE, 403],
      ["POST", base, STRANGER, CREATE, 403],
      ["PATCH", `${base}/tsk_nope`, EDITOR, { status: "done" }, 404],
      ["PATCH", `${base}/${id}`, VIEWER, { status: "done" }, 403],
      ["DELETE", `${base}/tsk_nope`, EDITOR, undefined, 404],
      ["PATCH", `${base}/reorder`, EDITOR, { timeframeBucket: "nope", orderedIds: [id] }, 400],
      ["POST", `${base}/templates/starter`, EDITOR, { items: ["no-such-item"] }, 400],
      ["POST", `${base}/templates/nope`, EDITOR, { items: [] }, 404],
      ["PUT", holderPath(id, OTHER_SEAT), EDITOR, undefined, 422],
      [
        "PATCH",
        `${base}/${id}`,
        EDITOR,
        { runTime: { kind: "fixed", at: "soon", timezone: "Australia/Sydney" } },
        400,
      ],
      [
        "PATCH",
        `${base}/${id}`,
        EDITOR,
        { runTime: { kind: "offset", eventId: "evt_nope", offsetMinutes: 0 } },
        422,
      ],
      [
        "PATCH",
        `${base}/${id}`,
        EDITOR,
        { runTime: { kind: "clock", eventId: "evt_nope", at: "2099-06-20T15:00" } },
        422,
      ],
      ["PUT", holderPath("tsk_nope", "whost_helper"), EDITOR, undefined, 404],
      ["DELETE", holderPath("tsk_nope", "whost_helper"), EDITOR, undefined, 404],
    ];
    for (const [method, path, who, body, status] of refusals) {
      expect((await req(app, method, path, who, body)).status, `${method} ${path}`).toBe(status);
    }
    expect(publishes).toStrictEqual([]);
  });

  it("not for a write that names nothing to change", async () => {
    const { app, publishes } = buildWithHub();
    const id = await newTask(app);
    publishes.length = 0;
    // A patch with no field reads the task and writes nothing.
    expect((await req(app, "PATCH", `${base}/${id}`, EDITOR, {})).status).toBe(200);
    // A reorder naming no task moves none.
    const reorder = { timeframeBucket: "12m", orderedIds: [] };
    expect((await req(app, "PATCH", `${base}/reorder`, EDITOR, reorder)).status).toBe(200);
    expect(publishes).toStrictEqual([]);
  });

  it("not for a reorder that moves nothing", async () => {
    const { app, publishes } = buildWithHub();
    const first = await newTask(app, "One");
    const second = await newTask(app, "Two");
    const other = await req(app, "POST", "/api/organiser/weddings/wed_other/tasks", "usr_bob", {
      ...CREATE,
      title: "Theirs",
    });
    expect(other.status).toBe(200);
    const theirs = ((await other.json()) as { task: { id: string } }).task.id;
    const reorder = (timeframeBucket: string, orderedIds: string[]) =>
      req(app, "PATCH", `${base}/reorder`, EDITOR, { timeframeBucket, orderedIds });
    // Put the bucket in a known order first.
    expect((await reorder("12m", [second, first])).status).toBe(200);
    publishes.length = 0;

    // The order it is already in.
    expect((await reorder("12m", [second, first])).status).toBe(200);
    // Another wedding's task.
    expect((await reorder("12m", [theirs])).status).toBe(200);
    // This wedding's tasks, named under a bucket they are not in.
    expect((await reorder("6m", [first, second])).status).toBe(200);
    expect(publishes).toStrictEqual([]);

    // A real move still tells the open tabs, once.
    expect((await reorder("12m", [first, second])).status).toBe(200);
    expect(publishes).toStrictEqual([changed()]);
  });

  it("not for a write past the organiser's limit, which is refused 429", async () => {
    const { app, publishes } = buildWithHub(
      "gold",
      false,
      createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    );
    expect((await req(app, "POST", base, EDITOR, CREATE)).status).toBe(200);
    const refused = await req(app, "POST", base, EDITOR, CREATE);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(publishes).toStrictEqual([changed()]);
    // Each organiser has a limit of their own, and reading spends none of it.
    expect((await req(app, "POST", base, OWNER, CREATE)).status).toBe(200);
    expect((await req(app, "GET", base, EDITOR)).status).toBe(200);
    // A caller the gates refuse is refused by them, before the limit.
    expect((await req(app, "POST", base, VIEWER, CREATE)).status).toBe(403);
    expect((await req(app, "POST", base, VIEWER, CREATE)).status).toBe(403);
  });

  it("never on a wedding below Gold, which refuses every task write", async () => {
    const { app, publishes } = buildWithHub("ivory");
    expect((await req(app, "POST", base, EDITOR, CREATE)).status).toBe(402);
    expect(publishes).toStrictEqual([]);
  });

  it("never for a write the database fails", async () => {
    const { db, app, publishes } = buildWithHub();
    const id = await newTask(app);
    publishes.length = 0;
    const failure = failStatements(db, (text) => text.startsWith('update "tasks"'));
    expect((await req(app, "PATCH", `${base}/${id}`, EDITOR, { status: "done" })).status).toBe(500);
    failure.restore();
    expect(publishes).toStrictEqual([]);
  });

  it("does not fail the write when the hub rejects", async () => {
    const { db, app } = buildWithHub("gold", true);
    const before = db.select().from(tasks).all().length;
    const res = await req(app, "POST", base, EDITOR, CREATE);
    expect(res.status).toBe(200);
    expect(db.select().from(tasks).all()).toHaveLength(before + 1);
  });
});
