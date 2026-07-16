import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, tasks, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import { tasksService, TaskNotInWedding } from "./tasks";

const OTHER = "wed_other";

function db0() {
  const db = createDb(":memory:");
  seedDb(db);
  db.insert(weddings)
    .values({
      id: OTHER,
      slug: "other",
      displayName: "Other",
      ownerOsnProfileId: "usr_bob",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return db;
}

const run = <A, E>(db: ReturnType<typeof createDb>, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(eff.pipe(Effect.provideService(DbService, db)));

describe("tasksService", () => {
  it("creates a task appended to the end of its bucket and lists it", async () => {
    const db = db0();
    const a = await run(
      db,
      tasksService.create({
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "Book venue",
        timeframeBucket: "12m",
        notes: null,
        dueAt: null,
      }),
    );
    const b = await run(
      db,
      tasksService.create({
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "Book caterer",
        timeframeBucket: "12m",
        notes: null,
        dueAt: null,
      }),
    );
    expect(Exit.isSuccess(a) && Exit.isSuccess(b)).toBe(true);
    const list = await run(db, tasksService.list(BOOTSTRAP_WEDDING_ID));
    if (!Exit.isSuccess(list)) throw new Error("list failed");
    expect(list.value.map((t) => t.title)).toEqual(["Book venue", "Book caterer"]);
    expect(list.value.map((t) => t.sortOrder)).toEqual([0, 1]);
    expect(list.value[0]!.status).toBe("open");
    expect(list.value[0]!.completedAt).toBeNull();
  });

  it("stamps completed_at on done and clears it on reopen", async () => {
    const db = db0();
    const created = await run(
      db,
      tasksService.create({
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "T",
        timeframeBucket: "6m",
        notes: null,
        dueAt: null,
      }),
    );
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const id = created.value.id;

    const done = await run(
      db,
      tasksService.update({
        weddingId: BOOTSTRAP_WEDDING_ID,
        taskId: id,
        patch: { status: "done" },
      }),
    );
    if (!Exit.isSuccess(done)) throw new Error("done failed");
    expect(done.value.status).toBe("done");
    expect(typeof done.value.completedAt).toBe("number");

    const reopened = await run(
      db,
      tasksService.update({
        weddingId: BOOTSTRAP_WEDDING_ID,
        taskId: id,
        patch: { status: "open" },
      }),
    );
    if (!Exit.isSuccess(reopened)) throw new Error("reopen failed");
    expect(reopened.value.completedAt).toBeNull();
  });

  it("rejects an update to another wedding's task (tenancy)", async () => {
    const db = db0();
    const created = await run(
      db,
      tasksService.create({
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "T",
        timeframeBucket: "6m",
        notes: null,
        dueAt: null,
      }),
    );
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const res = await run(
      db,
      tasksService.update({
        weddingId: OTHER,
        taskId: created.value.id,
        patch: { title: "hijack" },
      }),
    );
    expect(Exit.isFailure(res)).toBe(true);
    if (Exit.isFailure(res)) {
      expect(res.cause._tag === "Fail" && res.cause.error instanceof TaskNotInWedding).toBe(true);
    }
    // The task is untouched.
    const row = db
      .select({ title: tasks.title })
      .from(tasks)
      .where(eq(tasks.id, created.value.id))
      .get();
    expect(row?.title).toBe("T");
  });

  it("rejects deleting another wedding's task and deletes its own", async () => {
    const db = db0();
    const created = await run(
      db,
      tasksService.create({
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "T",
        timeframeBucket: "6m",
        notes: null,
        dueAt: null,
      }),
    );
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const foreign = await run(db, tasksService.remove(OTHER, created.value.id));
    expect(Exit.isFailure(foreign)).toBe(true);
    const own = await run(db, tasksService.remove(BOOTSTRAP_WEDDING_ID, created.value.id));
    expect(Exit.isSuccess(own)).toBe(true);
    expect(db.select().from(tasks).where(eq(tasks.id, created.value.id)).all().length).toBe(0);
  });

  it("reorders ids within a bucket by array index", async () => {
    const db = db0();
    const ids: string[] = [];
    for (const title of ["A", "B", "C"]) {
      const r = await run(
        db,
        tasksService.create({
          weddingId: BOOTSTRAP_WEDDING_ID,
          title,
          timeframeBucket: "3m",
          notes: null,
          dueAt: null,
        }),
      );
      if (!Exit.isSuccess(r)) throw new Error("create failed");
      ids.push(r.value.id);
    }
    // New order: C, A, B
    await run(db, tasksService.reorder(BOOTSTRAP_WEDDING_ID, "3m", [ids[2]!, ids[0]!, ids[1]!]));
    const list = await run(db, tasksService.list(BOOTSTRAP_WEDDING_ID));
    if (!Exit.isSuccess(list)) throw new Error("list failed");
    expect(list.value.map((t) => t.title)).toEqual(["C", "A", "B"]);
  });
});
