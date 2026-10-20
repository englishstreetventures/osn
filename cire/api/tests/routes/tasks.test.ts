import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, guests, taskAssignees, tasks, weddingHosts } from "@cire/db";
import { eq, sql } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, DEV_OWNER_SEAT_ID, seedDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { appRequest, failStatements, jsonBody, setTier } from "../test-helpers";
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
/** A seat on the other wedding, so never assignable on the bootstrap one. */
const OTHER_SEAT = "whost_other_editor";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp(tier: "ivory" | "gold" | "crimson" = "gold") {
  return createApp(buildDb(tier), { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
  });

  it("answers 500 and writes nothing when the database fails the write", async () => {
    const db = buildDb("gold");
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
    const app = createApp(db, { osnTestKey: auth.key });
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
