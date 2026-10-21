import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  registrySettings,
  taskTemplateDismissals,
  tasks,
  weddingHosts,
  weddings,
} from "@cire/db";
import { eq, sql } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CHECKLIST_TEMPLATES } from "../../src/lib/checklist-templates";
import { CIRE_METRICS } from "../../src/metrics";
import { refusal, appRequest, jsonBody, setTier } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

// The starter checklist over the real app and a real SQLite database: preview,
// apply, delete and re-apply, and what a wedding-date change does to the dates
// the starter wrote. The D1-only statement shapes are run again on Miniflare in
// tests/db/d1-integration.test.ts.

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";
const OTHER_OWNER = "usr_bob";
const OTHER = "wed_other";

const STARTER = CHECKLIST_TEMPLATES.starter;
const ALL_KEYS = STARTER.map((item) => item.key);

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

interface Task {
  id: string;
  title: string;
  timeframeBucket: string;
  dueAt: string | null;
  status: "open" | "done";
  sortOrder: number;
  templateId: string | null;
  templateItem: string | null;
  dueSource: "manual" | "template";
  assigneeHostIds: string[];
}

interface PreviewItem {
  key: string;
  title: string;
  timeframeBucket: string;
  dueAt: string | null;
  state: "new" | "added" | "removed";
}

interface Preview {
  templateId: string;
  weddingDate: string | null;
  items: PreviewItem[];
}

function buildDb(tier: "ivory" | "gold" = "gold"): TestDb {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  for (const [id, profile, role] of [
    ["whost_editor", EDITOR, "editor"],
    ["whost_viewer", VIEWER, "viewer"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: profile,
        addedByOsnProfileId: OWNER,
        role,
        createdAt: now,
      })
      .run();
  }
  insertWedding(db, {
    id: OTHER,
    slug: "other-wedding",
    displayName: "Other",
    createdAt: now,
    updatedAt: now,
    owners: [OTHER_OWNER],
  });
  setTier(db, BOOTSTRAP_WEDDING_ID, tier);
  setTier(db, OTHER, "gold");
  return db;
}

function build(tier: "ivory" | "gold" = "gold") {
  const db = buildDb(tier);
  return { db, app: createApp(db, { osnTestKey: auth.key }) };
}
type App = ReturnType<typeof build>["app"];

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

const weddingBase = (weddingId: string) => `/api/organiser/weddings/${weddingId}`;
const starterPath = (weddingId = BOOTSTRAP_WEDDING_ID) =>
  `${weddingBase(weddingId)}/tasks/templates/starter`;

async function preview(app: App, weddingId = BOOTSTRAP_WEDDING_ID, who = EDITOR) {
  const res = await req(app, "GET", starterPath(weddingId), who);
  expect(res.status).toBe(200);
  return ((await res.json()) as { preview: Preview }).preview;
}

async function apply(
  app: App,
  items: readonly string[] = ALL_KEYS,
  weddingId = BOOTSTRAP_WEDDING_ID,
  who = EDITOR,
) {
  const res = await req(app, "POST", starterPath(weddingId), who, { items });
  expect(res.status).toBe(200);
  return (await res.json()) as { added: number; tasks: Task[] };
}

async function list(app: App, weddingId = BOOTSTRAP_WEDDING_ID, who = EDITOR): Promise<Task[]> {
  const res = await req(app, "GET", `${weddingBase(weddingId)}/tasks`, who);
  expect(res.status).toBe(200);
  return ((await res.json()) as { tasks: Task[] }).tasks;
}

async function setWeddingDate(
  app: App,
  date: string | null,
  weddingId = BOOTSTRAP_WEDDING_ID,
  who = OWNER,
  extra: Record<string, unknown> = {},
) {
  return req(app, "PUT", `${weddingBase(weddingId)}/settings`, who, {
    weddingDate: date,
    ...extra,
  });
}

async function patchTask(app: App, taskId: string, patch: unknown) {
  const res = await req(
    app,
    "PATCH",
    `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks/${taskId}`,
    EDITOR,
    patch,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { task: Task }).task;
}

const seeded = (rows: readonly Task[], key: string): Task => {
  const row = rows.find((t) => t.templateItem === key);
  if (!row) throw new Error(`no task seeded from ${key}`);
  return row;
};

/** The due date the starter gives `key` on a wedding on `date`. */
const anchored = (key: string, date: string): string => {
  const item = STARTER.find((i) => i.key === key)!;
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + item.offsetDays!);
  return at.toISOString().slice(0, 10);
};

describe("applying the starter checklist", () => {
  it("adds each item once, however many times it is applied, and counts what it added", async () => {
    const { app } = build();
    const applied = () =>
      counterValue(CIRE_METRICS.checklistTemplateApplied, { template: "starter" });
    const before = await applied();
    const first = await apply(app);
    expect(first.added).toBe(ALL_KEYS.length);
    const second = await apply(app);
    expect(second.added).toBe(0);
    expect(second.tasks.length).toBe(ALL_KEYS.length);
    expect((await list(app)).length).toBe(ALL_KEYS.length);
    expect((await applied()) - before).toBe(ALL_KEYS.length);
  });

  it("refuses a second task for the same template item at the database", () => {
    const db = buildDb();
    const row = {
      weddingId: BOOTSTRAP_WEDDING_ID,
      title: "Agree on an overall budget",
      timeframeBucket: "12m",
      createdAt: new Date(),
      templateId: "starter",
      templateItem: "agree-budget",
      dueSource: "template" as const,
    };
    db.insert(tasks)
      .values({ ...row, id: "tsk_a" })
      .run();
    expect(
      refusal(() =>
        db
          .insert(tasks)
          .values({ ...row, id: "tsk_b" })
          .run(),
      ),
    ).toMatch(/UNIQUE/);
  });

  it("adds only the items picked, and reports the rest as still to add", async () => {
    const { app } = build();
    const picked = ALL_KEYS.slice(0, 3);
    const { added } = await apply(app, picked);
    expect(added).toBe(3);
    const items = (await preview(app)).items;
    for (const item of items) {
      expect({ key: item.key, state: item.state }).toEqual({
        key: item.key,
        state: picked.includes(item.key) ? "added" : "new",
      });
    }
  });

  it("puts seeded tasks after the tasks already in their bucket", async () => {
    const { app } = build();
    const created = await req(app, "POST", `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks`, EDITOR, {
      title: "Our own first task",
      timeframeBucket: "12m",
    });
    expect(created.status).toBe(200);
    const { tasks: rows } = await apply(app, ["agree-budget", "draft-guest-list"]);
    const twelve = rows
      .filter((t) => t.timeframeBucket === "12m")
      .toSorted((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => [t.title, t.sortOrder]);
    expect(twelve).toEqual([
      ["Our own first task", 0],
      ["Agree on an overall budget", 1],
      ["Draft a first guest list", 2],
    ]);
    // A later apply appends after the seeded ones too.
    const later = await apply(app, ["book-venues"]);
    expect(seeded(later.tasks, "book-venues").sortOrder).toBe(3);
  });

  it("marks what it seeds with the template and leaves a typed task unmarked", async () => {
    const { app } = build();
    await req(app, "POST", `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks`, EDITOR, {
      title: "Typed by hand",
      timeframeBucket: "1m",
    });
    const { tasks: rows } = await apply(app, ["agree-budget"]);
    const typed = rows.find((t) => t.title === "Typed by hand")!;
    expect([typed.templateId, typed.templateItem, typed.dueSource]).toEqual([null, null, "manual"]);
    const fromStarter = seeded(rows, "agree-budget");
    expect([fromStarter.templateId, fromStarter.dueSource]).toEqual(["starter", "template"]);
  });

  // The portal replaces its checklist with the answer, so an answer missing
  // the holders would empty every row's stack until the next read.
  it("answers with the holders of the tasks already on the checklist, and none on the new ones", async () => {
    const { app } = build();
    const created = await req(app, "POST", `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks`, EDITOR, {
      title: "Typed by hand",
      timeframeBucket: "1m",
    });
    const typedId = ((await created.json()) as { task: Task }).task.id;
    const first = await apply(app, ["agree-budget"]);
    const seededId = seeded(first.tasks, "agree-budget").id;
    for (const [taskId, seat] of [
      [typedId, "whost_viewer"],
      [typedId, "whost_editor"],
      [seededId, "whost_editor"],
    ] as const) {
      const res = await req(
        app,
        "PUT",
        `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks/${taskId}/assignees/${seat}`,
        EDITOR,
      );
      expect(res.status).toBe(200);
    }

    const { tasks: rows } = await apply(app, ["draft-guest-list"]);
    const holders = (id: string) => rows.find((t) => t.id === id)?.assigneeHostIds;
    expect(holders(typedId)).toEqual(["whost_viewer", "whost_editor"]);
    expect(holders(seededId)).toEqual(["whost_editor"]);
    expect(seeded(rows, "draft-guest-list").assigneeHostIds).toEqual([]);
  });
});

describe("the starter without a wedding date", () => {
  it("previews every item with no due date, and seeds them undated", async () => {
    const { app } = build();
    const shown = await preview(app);
    expect(shown.weddingDate).toBeNull();
    expect(shown.items.map((i) => i.key)).toEqual(ALL_KEYS);
    expect(shown.items.every((i) => i.dueAt === null && i.state === "new")).toBe(true);
    const { tasks: rows } = await apply(app);
    expect(rows.every((t) => t.dueAt === null && t.dueSource === "template")).toBe(true);
  });

  it("dates the seeded tasks once the date is set, and undates them when it is cleared", async () => {
    const { app } = build();
    await apply(app);
    expect((await setWeddingDate(app, "2027-10-09")).status).toBe(200);
    let rows = await list(app);
    for (const key of ALL_KEYS) expect(seeded(rows, key).dueAt).toBe(anchored(key, "2027-10-09"));
    expect((await setWeddingDate(app, null)).status).toBe(200);
    rows = await list(app);
    expect(rows.every((t) => t.dueAt === null)).toBe(true);
    expect((await setWeddingDate(app, "2027-12-04")).status).toBe(200);
    rows = await list(app);
    for (const key of ALL_KEYS) expect(seeded(rows, key).dueAt).toBe(anchored(key, "2027-12-04"));
  });
});

describe("the starter with a wedding date", () => {
  // The preview counts in JavaScript and the stored date comes from SQLite's
  // date(): across a leap day, and in a year below 100, which JavaScript's
  // Date.UTC would read as 19xx.
  it.each([
    ["2028-03-01", "2027-03-02"],
    ["0050-06-15", "0049-06-15"],
  ])("stores the due dates its preview showed, for a wedding on %s", async (date, budgetDue) => {
    const { app } = build();
    expect((await setWeddingDate(app, date)).status).toBe(200);
    const shown = await preview(app);
    expect(shown.weddingDate).toBe(date);
    expect(shown.items.find((i) => i.key === "agree-budget")?.dueAt).toBe(budgetDue);
    const { tasks: rows } = await apply(app);
    for (const item of shown.items) expect(seeded(rows, item.key).dueAt).toBe(item.dueAt);
  });
});

describe("moving the wedding date", () => {
  async function seededWedding(date = "2027-06-05") {
    const built = build();
    expect((await setWeddingDate(built.app, date)).status).toBe(200);
    const { tasks: rows } = await apply(built.app);
    return { ...built, rows };
  }

  it("moves the open seeded tasks", async () => {
    const { app } = await seededWedding();
    expect((await setWeddingDate(app, "2027-09-04")).status).toBe(200);
    const rows = await list(app);
    for (const key of ALL_KEYS) expect(seeded(rows, key).dueAt).toBe(anchored(key, "2027-09-04"));
  });

  it("leaves a completed seeded task on its date", async () => {
    const { app, rows } = await seededWedding();
    const done = seeded(rows, "book-venues");
    await patchTask(app, done.id, { status: "done" });
    await setWeddingDate(app, "2027-09-04");
    expect(seeded(await list(app), "book-venues").dueAt).toBe(
      anchored("book-venues", "2027-06-05"),
    );
  });

  it("gives a reopened seeded task the current date's due date", async () => {
    const { app, rows } = await seededWedding();
    const task = seeded(rows, "book-venues");
    await patchTask(app, task.id, { status: "done" });
    await setWeddingDate(app, "2027-09-04");
    const reopened = await patchTask(app, task.id, { status: "open" });
    expect(reopened.dueAt).toBe(anchored("book-venues", "2027-09-04"));
  });

  it("leaves the date of a reopened task whose date is not the template's", async () => {
    const { app, rows } = await seededWedding();
    const typed = await req(app, "POST", `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks`, EDITOR, {
      title: "Typed by hand",
      timeframeBucket: "3m",
      dueAt: "2027-03-01",
    });
    const { task: own } = (await typed.json()) as { task: Task };
    const moved = seeded(rows, "send-invitations");
    await patchTask(app, moved.id, { dueAt: "2027-02-14" });
    for (const id of [own.id, moved.id]) await patchTask(app, id, { status: "done" });
    await setWeddingDate(app, "2027-09-04");
    expect((await patchTask(app, own.id, { status: "open" })).dueAt).toBe("2027-03-01");
    expect((await patchTask(app, moved.id, { status: "open" })).dueAt).toBe("2027-02-14");
  });

  it("does not count an empty due date sent back on an undated seeded task as the couple's own", async () => {
    const { app } = build();
    const { tasks: rows } = await apply(app, ["send-invitations"]);
    const task = seeded(rows, "send-invitations");
    const edited = await patchTask(app, task.id, { title: "Post the invitations", dueAt: null });
    expect(edited.dueSource).toBe("template");
    await setWeddingDate(app, "2027-09-04");
    expect(seeded(await list(app), "send-invitations").dueAt).toBe(
      anchored("send-invitations", "2027-09-04"),
    );
  });

  it("keeps the date a reopen sends with it", async () => {
    const { app, rows } = await seededWedding();
    const task = seeded(rows, "book-venues");
    await patchTask(app, task.id, { status: "done" });
    const reopened = await patchTask(app, task.id, { status: "open", dueAt: "2026-12-01" });
    expect([reopened.dueAt, reopened.dueSource]).toEqual(["2026-12-01", "manual"]);
  });

  it("leaves a done task's date alone when it is marked done again", async () => {
    const { app, rows } = await seededWedding();
    const task = seeded(rows, "book-venues");
    await patchTask(app, task.id, { status: "done" });
    await setWeddingDate(app, "2027-09-04");
    const again = await patchTask(app, task.id, { status: "done" });
    expect(again.dueAt).toBe(anchored("book-venues", "2027-06-05"));
  });

  it("leaves a due date the couple set themselves", async () => {
    const { app, rows } = await seededWedding();
    const task = seeded(rows, "send-invitations");
    const moved = await patchTask(app, task.id, { dueAt: "2027-02-14" });
    expect(moved.dueSource).toBe("manual");
    await setWeddingDate(app, "2027-09-04");
    expect(seeded(await list(app), "send-invitations").dueAt).toBe("2027-02-14");
  });

  it("does not count an unchanged due date sent back with an edit as the couple's own", async () => {
    const { app, rows } = await seededWedding();
    const task = seeded(rows, "send-invitations");
    const edited = await patchTask(app, task.id, {
      title: "Post the invitations",
      dueAt: task.dueAt,
    });
    expect(edited.dueSource).toBe("template");
    await setWeddingDate(app, "2027-09-04");
    expect(seeded(await list(app), "send-invitations").dueAt).toBe(
      anchored("send-invitations", "2027-09-04"),
    );
  });

  it("leaves a typed task alone", async () => {
    const { app } = await seededWedding();
    const res = await req(app, "POST", `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks`, EDITOR, {
      title: "Typed by hand",
      timeframeBucket: "3m",
      dueAt: "2027-03-01",
    });
    expect(res.status).toBe(200);
    await setWeddingDate(app, "2027-09-04");
    expect((await list(app)).find((t) => t.title === "Typed by hand")?.dueAt).toBe("2027-03-01");
  });

  it("leaves another wedding's seeded tasks alone", async () => {
    const { app } = await seededWedding();
    expect((await setWeddingDate(app, "2028-01-15", OTHER, OTHER_OWNER)).status).toBe(200);
    await apply(app, ALL_KEYS, OTHER, OTHER_OWNER);
    await setWeddingDate(app, "2027-09-04");
    const theirs = await list(app, OTHER, OTHER_OWNER);
    for (const key of ALL_KEYS) expect(seeded(theirs, key).dueAt).toBe(anchored(key, "2028-01-15"));
  });

  it("leaves the tasks alone when the save that carried the date is refused", async () => {
    const { app, db } = await seededWedding();
    const now = new Date();
    db.insert(registrySettings)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        published: true,
        cashGiftsEnabled: true,
        stripeAccountId: "acct_couple",
        stripeChargesEnabled: true,
        stripeDefaultCurrency: "AUD",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const refused = await setWeddingDate(app, "2027-09-04", BOOTSTRAP_WEDDING_ID, OWNER, {
      currency: "NZD",
    });
    expect(refused.status).toBe(409);
    const rows = await list(app);
    for (const key of ALL_KEYS) expect(seeded(rows, key).dueAt).toBe(anchored(key, "2027-06-05"));
  });

  it("follows the stored date whenever a save carries the date, changed or not", async () => {
    const { app, db } = await seededWedding();
    // The stored date moved without its tasks — a save from another tab that
    // read the old date is the way this happens.
    db.update(weddings)
      .set({ weddingDate: "2027-09-04" })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
    expect((await setWeddingDate(app, "2027-09-04")).status).toBe(200);
    const rows = await list(app);
    for (const key of ALL_KEYS) expect(seeded(rows, key).dueAt).toBe(anchored(key, "2027-09-04"));
  });
});

describe("removing a seeded task", () => {
  it("is not undone by applying the starter again unless the couple picks it", async () => {
    const { app, db } = build();
    const { tasks: rows } = await apply(app);
    const gone = seeded(rows, "plan-outfits");
    const del = await req(
      app,
      "DELETE",
      `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks/${gone.id}`,
      EDITOR,
    );
    expect(del.status).toBe(200);
    expect((await preview(app)).items.find((i) => i.key === "plan-outfits")?.state).toBe("removed");

    // Everything the portal ticks by default: the new items, never a removed one.
    const again = await apply(
      app,
      ALL_KEYS.filter((k) => k !== "plan-outfits"),
    );
    expect(again.added).toBe(0);
    expect(again.tasks.some((t) => t.templateItem === "plan-outfits")).toBe(false);

    // Picking it is the confirmation.
    const restored = await apply(app, ["plan-outfits"]);
    expect(restored.added).toBe(1);
    expect((await preview(app)).items.find((i) => i.key === "plan-outfits")?.state).toBe("added");
    expect(
      db
        .select()
        .from(taskTemplateDismissals)
        .where(eq(taskTemplateDismissals.weddingId, BOOTSTRAP_WEDDING_ID))
        .all(),
    ).toEqual([]);

    // And deleting it again records the removal again.
    const back = seeded(restored.tasks, "plan-outfits");
    await req(app, "DELETE", `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks/${back.id}`, EDITOR);
    expect((await preview(app)).items.find((i) => i.key === "plan-outfits")?.state).toBe("removed");
  });

  it("records nothing when a typed task is deleted", async () => {
    const { app, db } = build();
    const res = await req(app, "POST", `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks`, EDITOR, {
      title: "Agree on an overall budget",
      timeframeBucket: "12m",
    });
    const { task } = (await res.json()) as { task: Task };
    await req(app, "DELETE", `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks/${task.id}`, EDITOR);
    expect(db.select().from(taskTemplateDismissals).all()).toEqual([]);
  });
});

describe("who may preview and apply the starter", () => {
  it("refuses a viewer both, with the read-only answer", async () => {
    const { app } = build();
    for (const method of ["GET", "POST"]) {
      const res = await req(app, method, starterPath(), VIEWER, { items: ALL_KEYS });
      expect(res.status, method).toBe(403);
      expect(await jsonBody(res)).toEqual({ error: "read_only_role" });
    }
    expect(await list(app, BOOTSTRAP_WEDDING_ID, OWNER)).toEqual([]);
  });

  it("refuses someone with no seat, and a caller with no token", async () => {
    const { app } = build();
    for (const method of ["GET", "POST"]) {
      expect((await req(app, method, starterPath(), STRANGER, { items: ALL_KEYS })).status).toBe(
        403,
      );
      expect((await req(app, method, starterPath(), undefined, { items: ALL_KEYS })).status).toBe(
        401,
      );
    }
  });

  it("answers 402 below Gold", async () => {
    const { app } = build("ivory");
    for (const method of ["GET", "POST"]) {
      const res = await req(app, method, starterPath(), OWNER, { items: ALL_KEYS });
      expect(res.status, method).toBe(402);
      expect(await jsonBody(res)).toEqual({ error: "payment_required", tier: "gold" });
    }
  });

  it("answers 404 for a template that does not exist", async () => {
    const { app } = build();
    const path = `${weddingBase(BOOTSTRAP_WEDDING_ID)}/tasks/templates/nonesuch`;
    for (const method of ["GET", "POST"]) {
      const res = await req(app, method, path, EDITOR, { items: [] });
      expect(res.status, method).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "template_not_found" });
    }
  });

  it("answers a database failure with a bare 500, telling the caller nothing more", async () => {
    const { app, db } = build();
    db.run(sql`DROP TABLE task_template_dismissals`);
    for (const method of ["GET", "POST"]) {
      const res = await req(app, method, starterPath(), EDITOR, { items: ALL_KEYS });
      expect(res.status, method).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "Internal error" });
    }
  });

  it("refuses an item the template does not have, and a malformed body", async () => {
    const { app } = build();
    for (const body of [
      { items: ["agree-budget", "not-an-item"] },
      { items: "agree-budget" },
      {},
      { items: [42] },
      { items: Array.from({ length: 101 }, () => "agree-budget") },
    ]) {
      const res = await req(app, "POST", starterPath(), EDITOR, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
    }
    expect(await list(app)).toEqual([]);
  });

  it("adds nothing for an empty pick, and answers with the checklist", async () => {
    const { app } = build();
    const empty = await apply(app, []);
    expect(empty).toEqual({ added: 0, tasks: [] });
  });

  // The portal reaches these routes with the organiser session cookie, so the
  // cookie path has to hold for them, not only the bearer the tests above send.
  it("accepts the session cookie and refuses a dead one", async () => {
    const { app, db } = build();
    const token = await seedOrganiserSession(db, EDITOR);
    const ok = await appRequest(app, starterPath(), {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `cire_org_session=${token}` },
      body: JSON.stringify({ items: ["agree-budget"] }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { added: number }).added).toBe(1);
    for (const method of ["GET", "POST"]) {
      const dead = await appRequest(app, starterPath(), {
        method,
        headers: {
          "Content-Type": "application/json",
          cookie: "cire_org_session=not-a-live-session-token",
        },
        body: method === "POST" ? JSON.stringify({ items: ["agree-budget"] }) : undefined,
      });
      expect(dead.status, method).toBe(401);
    }
  });
});
