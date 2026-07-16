import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingHosts, weddings } from "@cire/db";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp() {
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
  db.insert(weddings)
    .values({
      id: "wed_other",
      slug: "other-wedding",
      displayName: "Other",
      ownerOsnProfileId: "usr_bob",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return createApp(db, { osnTestKey: auth.key });
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
