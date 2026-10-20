import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, guests, tasks, weddingHosts } from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, DEV_OWNER_SEAT_ID, seedDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { appRequest, failStatements, jsonBody, setTier } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
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
      ["PUT", `${base}/tsk_x/assignee`, EDITOR, { assignedHostId: null }],
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

type TaskBody = { task: { id: string; assignedHostId: string | null } };

describe("assigning a task to a seat", () => {
  const assignee = (taskId: string) => `${base}/${taskId}/assignee`;

  async function createTask(app: App, title = "Carry the rings"): Promise<string> {
    const res = await req(app, "POST", base, EDITOR, { title, timeframeBucket: "day_of" });
    expect(res.status).toBe(200);
    const { task } = (await res.json()) as TaskBody;
    // Nobody holds a task the couple has just typed.
    expect(task.assignedHostId).toBeNull();
    return task.id;
  }

  async function assigneeOf(app: App, taskId: string): Promise<string | null | undefined> {
    const res = await req(app, "GET", base, OWNER);
    const { tasks: list } = (await res.json()) as { tasks: TaskBody["task"][] };
    return list.find((t) => t.id === taskId)?.assignedHostId;
  }

  /** Set up an assignment the test goes on to depend on. */
  async function assignTo(app: App, taskId: string, seat: string): Promise<void> {
    const res = await req(app, "PUT", assignee(taskId), EDITOR, { assignedHostId: seat });
    expect(res.status, seat).toBe(200);
  }

  const counted = (action: string, result: string) =>
    counterValue(CIRE_METRICS.taskAssignmentChanged, { action, result });

  it("assigns, reassigns and unassigns, and the list carries each answer", async () => {
    const app = buildApp();
    const id = await createTask(app);
    const assignedBefore = await counted("assign", "ok");
    const unassignedBefore = await counted("unassign", "ok");

    const toHelper = await req(app, "PUT", assignee(id), EDITOR, {
      assignedHostId: "whost_helper",
    });
    expect(toHelper.status).toBe(200);
    expect(((await toHelper.json()) as TaskBody).task).toMatchObject({
      id,
      assignedHostId: "whost_helper",
    });
    expect(await assigneeOf(app, id)).toBe("whost_helper");

    const toViewer = await req(app, "PUT", assignee(id), OWNER, { assignedHostId: "whost_viewer" });
    expect(((await toViewer.json()) as TaskBody).task.assignedHostId).toBe("whost_viewer");
    expect(await assigneeOf(app, id)).toBe("whost_viewer");

    const cleared = await req(app, "PUT", assignee(id), EDITOR, { assignedHostId: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as TaskBody).task.assignedHostId).toBeNull();
    expect(await assigneeOf(app, id)).toBeNull();

    expect((await counted("assign", "ok")) - assignedBefore).toBe(2);
    expect((await counted("unassign", "ok")) - unassignedBefore).toBe(1);
  });

  it("assigns to any seat of the wedding, whatever its role", async () => {
    const app = buildApp();
    const id = await createTask(app);
    for (const seat of [DEV_OWNER_SEAT_ID, "whost_editor", "whost_viewer", "whost_helper"]) {
      const res = await req(app, "PUT", assignee(id), EDITOR, { assignedHostId: seat });
      expect(res.status, seat).toBe(200);
      expect(await assigneeOf(app, id), seat).toBe(seat);
    }
  });

  it("422s a seat of another wedding, a guest id and an id that names nothing, and keeps the assignee", async () => {
    const db = buildDb("gold");
    const app = createApp(db, { osnTestKey: auth.key });
    const id = await createTask(app);
    await assignTo(app, id, "whost_helper");
    const guestId = db.select({ id: guests.id }).from(guests).limit(1).all()[0]!.id;
    const before = await counted("assign", "assignee_not_in_wedding");

    for (const stranger of [OTHER_SEAT, guestId, "whost_nobody", id]) {
      const res = await req(app, "PUT", assignee(id), EDITOR, { assignedHostId: stranger });
      expect(res.status, stranger).toBe(422);
      expect(await jsonBody(res)).toEqual({ error: "assignee_not_in_wedding" });
    }
    expect(await assigneeOf(app, id)).toBe("whost_helper");
    expect((await counted("assign", "assignee_not_in_wedding")) - before).toBe(4);
  });

  it("400s a body that is not one seat id or null", async () => {
    const app = buildApp();
    const id = await createTask(app);
    for (const body of [
      {},
      { assignedHostId: 7 },
      { assignedHostId: "" },
      { assignedHostId: "w".repeat(65) },
      { assignedHostId: ["whost_helper"] },
      "whost_helper",
    ]) {
      const res = await req(app, "PUT", assignee(id), EDITOR, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
    }
    const garbled = await appRequest(app, assignee(id), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.sign(EDITOR)}`,
      },
      body: "{not json",
    });
    expect(garbled.status).toBe(400);
    expect(await assigneeOf(app, id)).toBeNull();
  });

  it("refuses a viewer, a helper, a stranger and no token, and changes nothing", async () => {
    const app = buildApp();
    const id = await createTask(app);
    const body = { assignedHostId: "whost_helper" };

    const viewer = await req(app, "PUT", assignee(id), VIEWER, body);
    expect(viewer.status).toBe(403);
    expect(await jsonBody(viewer)).toMatchObject({ error: "read_only_role" });

    for (const caller of [HELPER, STRANGER]) {
      const res = await req(app, "PUT", assignee(id), caller, body);
      expect(res.status, caller).toBe(403);
      expect(await jsonBody(res), caller).toMatchObject({ error: "forbidden" });
    }
    expect((await req(app, "PUT", assignee(id), undefined, body)).status).toBe(401);
    expect(await assigneeOf(app, id)).toBeNull();
  });

  it("404s a task of another wedding, and leaves that task alone", async () => {
    const db = buildDb("gold");
    const app = createApp(db, { osnTestKey: auth.key });
    const id = await createTask(app);
    await assignTo(app, id, "whost_viewer");
    const before = await counted("assign", "task_not_found");

    // usr_bob owns wed_other: the task id is real, but not that wedding's —
    // with a seat of wed_other, so only the task decides the answer.
    const foreign = `/api/organiser/weddings/wed_other/tasks/${id}/assignee`;
    const res = await req(app, "PUT", foreign, "usr_bob", { assignedHostId: OTHER_SEAT });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "task_not_found" });
    const cleared = await req(app, "PUT", foreign, "usr_bob", { assignedHostId: null });
    expect(cleared.status).toBe(404);
    expect(await assigneeOf(app, id)).toBe("whost_viewer");
    expect((await counted("assign", "task_not_found")) - before).toBe(1);

    const missing = await req(app, "PUT", assignee("tsk_missing"), EDITOR, {
      assignedHostId: "whost_helper",
    });
    expect(missing.status).toBe(404);
    expect(await jsonBody(missing)).toEqual({ error: "task_not_found" });
  });

  it("answers 500 and writes nothing when the database fails the write", async () => {
    const db = buildDb("gold");
    const app = createApp(db, { osnTestKey: auth.key });
    const id = await createTask(app);
    const failure = failStatements(db, (sql) =>
      sql.startsWith('update "tasks" set "assigned_host_id"'),
    );

    const res = await req(app, "PUT", assignee(id), EDITOR, { assignedHostId: "whost_helper" });
    expect(failure.failed()).toBe(1);
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ error: "Internal error" });
    failure.restore();
    expect(await assigneeOf(app, id)).toBeNull();
  });

  it("keeps the task, unassigned, when an owner removes the seat it was assigned to", async () => {
    const db = buildDb("gold");
    const app = createApp(db, { osnTestKey: auth.key });
    const id = await createTask(app);
    const kept = await createTask(app, "Mind the cake");
    await assignTo(app, id, "whost_helper");
    await assignTo(app, kept, "whost_viewer");

    const removed = await req(
      app,
      "DELETE",
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/hosts/${HELPER}`,
      OWNER,
    );
    expect(removed.status).toBe(200);
    expect(await assigneeOf(app, id)).toBeNull();
    // Another seat's assignment is untouched.
    expect(await assigneeOf(app, kept)).toBe("whost_viewer");
    expect(db.select().from(tasks).where(eq(tasks.id, id)).all()).toHaveLength(1);
  });

  it("keeps the task, unassigned, when its assignee leaves the wedding", async () => {
    const app = buildApp();
    const id = await createTask(app);
    await assignTo(app, id, "whost_viewer");

    const left = await req(
      app,
      "DELETE",
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/hosts/me`,
      VIEWER,
    );
    expect(left.status).toBe(200);
    expect(await assigneeOf(app, id)).toBeNull();
  });

  it("keeps the assignment when the last owner's leave is refused", async () => {
    const app = buildApp();
    const id = await createTask(app);
    await assignTo(app, id, DEV_OWNER_SEAT_ID);

    const left = await req(
      app,
      "DELETE",
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/hosts/me`,
      OWNER,
    );
    expect(left.status).toBe(409);
    expect(await assigneeOf(app, id)).toBe(DEV_OWNER_SEAT_ID);
  });
});
