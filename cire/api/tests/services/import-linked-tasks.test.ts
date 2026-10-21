import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  taskAssignees,
  tasks,
  taskTemplateDismissals,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import { createDb, DEV_OWNER_SEAT_ID, seedBootstrapWedding, type TestDb } from "../../src/db/setup";
import type { ImportPlan } from "../../src/schemas/import";
import { currentEventsAsParsed } from "../../src/services/changes";
import { applyImport, diffAgainstDb } from "../../src/services/import";
import { recordStatements } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

/**
 * A schedule change that removes an event a checklist task is linked to. The
 * preview lists those tasks; the organiser may remove some of them with the
 * event (the apply names their ids); every other one stays on the checklist,
 * unlinked, at the time it last had on the removed event's clock, marked
 * "event removed". Tasks, the template dismissal of a removed seeded task and
 * the event delete commit in one batch per removed event.
 */

const W = BOOTSTRAP_WEDDING_ID;
/** 01:30 Sydney on the morning the clocks go forward (AEST → AEDT at 02:00). */
const GAP_MORNING = "evt_gap";
const RECEPTION = "evt_reception";
const BRUNCH = "evt_brunch";

function build(): TestDb {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  insertWedding(db, { id: "wed_other", slug: "other", displayName: "Other", owners: ["usr_b"] });
  const ev = (id: string, weddingId: string, name: string, startAt: string, sortOrder: number) => ({
    id,
    weddingId,
    slug: id,
    name,
    startAt,
    endAt: "",
    timezone: "Australia/Sydney",
    sortOrder,
  });
  db.insert(events)
    .values([
      ev(GAP_MORNING, W, "Sunrise", "2099-10-04T01:30:00+10:00", 0),
      ev(RECEPTION, W, "Reception", "2099-06-20T18:00:00+10:00", 1),
      ev(BRUNCH, W, "Brunch", "2099-06-21T10:00:00+10:00", 2),
      ev("evt_theirs", "wed_other", "Reception", "2099-06-20T18:00:00+10:00", 0),
    ])
    .run();
  const now = new Date();
  const task = (
    id: string,
    weddingId: string,
    run: Partial<typeof tasks.$inferInsert>,
  ): typeof tasks.$inferInsert => ({
    id,
    weddingId,
    title: `Title ${id}`,
    timeframeBucket: "day_of",
    createdAt: now,
    ...run,
  });
  db.insert(tasks)
    .values([
      task("t_sunrise", W, { eventId: GAP_MORNING, runOffsetMinutes: 60 }),
      task("t_cake", W, {
        eventId: RECEPTION,
        runOffsetMinutes: -60,
        templateId: "starter",
        templateItem: "cake",
        dueSource: "template",
      }),
      task("t_toast", W, { eventId: RECEPTION, runOffsetMinutes: 30 }),
      task("t_brunch", W, { eventId: BRUNCH, runOffsetMinutes: 0 }),
      task("t_loose", W, {}),
      task("t_theirs", "wed_other", { eventId: "evt_theirs", runOffsetMinutes: 0 }),
    ])
    .run();
  db.insert(taskAssignees)
    .values({ taskId: "t_cake", hostId: DEV_OWNER_SEAT_ID, weddingId: W, assignedAt: now })
    .run();
  return db;
}

const layer = (db: TestDb) => Layer.succeed(DbService, db);

/** The plan of a change that keeps only `keep` of the wedding's events. */
async function planKeeping(db: TestDb, keep: readonly string[]): Promise<ImportPlan> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const current = yield* currentEventsAsParsed(W);
      return yield* diffAgainstDb(
        current.filter((e) => keep.includes(e.id!)),
        [],
        W,
        { scope: "events", matchByName: false },
      );
    }).pipe(Effect.provide(layer(db))),
  );
}

function apply(db: TestDb, plan: ImportPlan, removeLinkedTasks?: readonly string[]) {
  return Effect.runPromise(
    applyImport("chg_test", plan, W, [], { removeLinkedTasks }).pipe(Effect.provide(layer(db))),
  );
}

const row = (db: TestDb, id: string) =>
  db
    .select({
      eventId: tasks.eventId,
      runOffsetMinutes: tasks.runOffsetMinutes,
      runAt: tasks.runAt,
      runTimezone: tasks.runTimezone,
      eventRemovedAt: tasks.eventRemovedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, id))
    .get();

describe("a schedule change's preview lists the tasks linked to the events it removes", () => {
  it("lists them with the time each would keep, on the removed event's clock", async () => {
    const plan = await planKeeping(build(), [BRUNCH]);
    expect(plan.eventRemoves.map((e) => e.id).toSorted()).toEqual([GAP_MORNING, RECEPTION]);
    expect((plan.linkedTasks ?? []).toSorted((a, b) => (a.id < b.id ? -1 : 1))).toEqual([
      {
        id: "t_cake",
        title: "Title t_cake",
        eventId: RECEPTION,
        offsetMinutes: -60,
        frozenRunAt: "2099-06-20T17:00:00+10:00",
        frozenTimezone: "Australia/Sydney",
      },
      {
        // An hour after 01:30 on the morning the clocks go forward is 03:30.
        id: "t_sunrise",
        title: "Title t_sunrise",
        eventId: GAP_MORNING,
        offsetMinutes: 60,
        frozenRunAt: "2099-10-04T03:30:00+11:00",
        frozenTimezone: "Australia/Sydney",
      },
      {
        id: "t_toast",
        title: "Title t_toast",
        eventId: RECEPTION,
        offsetMinutes: 30,
        frozenRunAt: "2099-06-20T18:30:00+10:00",
        frozenTimezone: "Australia/Sydney",
      },
    ]);
  });

  it("lists none for a change that removes no event, and reads no task to find out", async () => {
    const db = build();
    const recorded = recordStatements(db);
    const plan = await planKeeping(db, [GAP_MORNING, RECEPTION, BRUNCH]);
    expect(plan.eventRemoves).toEqual([]);
    expect(plan.linkedTasks ?? []).toEqual([]);
    expect(recorded.filter((r) => /from "tasks"/i.test(r.sql))).toEqual([]);
  });

  it("lists a task whose removed event has no start it can read with no time to keep", async () => {
    const db = build();
    db.insert(events)
      .values({
        id: "evt_tbc",
        weddingId: W,
        slug: "tbc",
        name: "Afterparty",
        startAt: "TBC",
        endAt: "",
        timezone: "Australia/Sydney",
        sortOrder: 9,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "t_tbc",
        weddingId: W,
        title: "Book the taxi",
        timeframeBucket: "day_of",
        createdAt: new Date(),
        eventId: "evt_tbc",
        runOffsetMinutes: 15,
      })
      .run();
    const plan = await planKeeping(db, [GAP_MORNING, RECEPTION, BRUNCH]);
    expect(plan.linkedTasks).toEqual([
      {
        id: "t_tbc",
        title: "Book the taxi",
        eventId: "evt_tbc",
        offsetMinutes: 15,
        frozenRunAt: null,
        frozenTimezone: null,
      },
    ]);

    await apply(db, plan);
    // Kept, unlinked and marked, with no time rather than a made-up one.
    expect(row(db, "t_tbc")).toMatchObject({
      eventId: null,
      runOffsetMinutes: null,
      runAt: null,
      runTimezone: null,
    });
    expect(row(db, "t_tbc")?.eventRemovedAt).not.toBeNull();
  });
});

describe("applying it", () => {
  it("keeps every linked task when the apply names none, unlinked, at its last time, marked", async () => {
    const db = build();
    const before = Date.now();
    await apply(db, await planKeeping(db, [BRUNCH]));

    expect(row(db, "t_sunrise")).toMatchObject({
      eventId: null,
      runOffsetMinutes: null,
      runAt: "2099-10-04T03:30:00+11:00",
      runTimezone: "Australia/Sydney",
    });
    expect(row(db, "t_toast")).toMatchObject({
      eventId: null,
      runOffsetMinutes: null,
      runAt: "2099-06-20T18:30:00+10:00",
      runTimezone: "Australia/Sydney",
    });
    for (const id of ["t_sunrise", "t_cake", "t_toast"]) {
      expect(row(db, id)?.eventRemovedAt?.getTime()).toBeGreaterThanOrEqual(
        Math.floor(before / 1000) * 1000,
      );
    }
    // Untouched: a task linked to a surviving event, an unlinked one, and
    // another wedding's.
    expect(row(db, "t_brunch")).toMatchObject({
      eventId: BRUNCH,
      runOffsetMinutes: 0,
      eventRemovedAt: null,
    });
    expect(row(db, "t_loose")).toMatchObject({ eventId: null, runAt: null, eventRemovedAt: null });
    expect(row(db, "t_theirs")).toMatchObject({ eventId: "evt_theirs", eventRemovedAt: null });
    // The cake keeps its holder.
    expect(
      db.select().from(taskAssignees).where(eq(taskAssignees.taskId, "t_cake")).all(),
    ).toHaveLength(1);
    expect(db.select({ id: events.id }).from(events).where(eq(events.weddingId, W)).all()).toEqual([
      { id: BRUNCH },
    ]);
  });

  it("removes the listed tasks, their holders with them, and remembers a removed seeded one", async () => {
    const db = build();
    await apply(db, await planKeeping(db, [BRUNCH]), ["t_cake"]);

    expect(row(db, "t_cake")).toBeUndefined();
    expect(db.select().from(taskAssignees).where(eq(taskAssignees.taskId, "t_cake")).all()).toEqual(
      [],
    );
    expect(
      db
        .select({
          templateId: taskTemplateDismissals.templateId,
          item: taskTemplateDismissals.templateItem,
        })
        .from(taskTemplateDismissals)
        .all(),
    ).toEqual([{ templateId: "starter", item: "cake" }]);
    // The rest of the reception's tasks stay, frozen.
    expect(row(db, "t_toast")).toMatchObject({ eventId: null, runAt: "2099-06-20T18:30:00+10:00" });
  });

  it("removes nothing the apply names that is not linked to an event it removes", async () => {
    const db = build();
    await apply(db, await planKeeping(db, [BRUNCH]), ["t_brunch", "t_loose", "t_theirs", "t_nope"]);
    for (const id of ["t_brunch", "t_loose"]) expect(row(db, id), id).toBeDefined();
    expect(db.select().from(tasks).where(eq(tasks.id, "t_theirs")).get()).toBeDefined();
    expect(db.select().from(taskTemplateDismissals).all()).toEqual([]);
  });

  it("keeps a listed task that was linked to a surviving event after the preview", async () => {
    const db = build();
    const plan = await planKeeping(db, [BRUNCH]);
    db.update(tasks)
      .set({ eventId: BRUNCH, runOffsetMinutes: -15 })
      .where(eq(tasks.id, "t_toast"))
      .run();

    await apply(db, plan, ["t_toast"]);

    expect(row(db, "t_toast")).toMatchObject({
      eventId: BRUNCH,
      runOffsetMinutes: -15,
      runAt: null,
      eventRemovedAt: null,
    });
  });

  it("keeps a task linked to a removed event after the preview, unlinked and marked, rather than half-set", async () => {
    const db = build();
    const plan = await planKeeping(db, [BRUNCH]);
    // At an offset the preview never read: its time cannot be known, so it
    // keeps none — but it is never left with an offset and no event.
    db.update(tasks)
      .set({ eventId: RECEPTION, runOffsetMinutes: 45 })
      .where(eq(tasks.id, "t_loose"))
      .run();
    // At an offset the preview did read: the same instant is known.
    db.update(tasks)
      .set({ eventId: RECEPTION, runOffsetMinutes: 30 })
      .where(eq(tasks.id, "t_brunch"))
      .run();

    await apply(db, plan, ["t_loose"]);

    expect(row(db, "t_loose")).toMatchObject({
      eventId: null,
      runOffsetMinutes: null,
      runAt: null,
      runTimezone: null,
    });
    expect(row(db, "t_loose")?.eventRemovedAt).not.toBeNull();
    expect(row(db, "t_brunch")).toMatchObject({
      eventId: null,
      runAt: "2099-06-20T18:30:00+10:00",
      runTimezone: "Australia/Sydney",
    });
  });

  it("freezes each task at its own event's time and zone when two removed events share an offset", async () => {
    const db = build();
    // Six in the evening in Kolkata, with a task an hour before it: the same
    // offset as the cake table's on the Reception, on another clock.
    db.insert(events)
      .values({
        id: "evt_kolkata",
        weddingId: W,
        slug: "kolkata",
        name: "Sangeet",
        startAt: "2099-06-20T18:00:00+05:30",
        endAt: "",
        timezone: "Asia/Kolkata",
        sortOrder: 9,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "t_kolkata",
        weddingId: W,
        title: "Light the lamps",
        timeframeBucket: "day_of",
        createdAt: new Date(),
        eventId: "evt_kolkata",
        runOffsetMinutes: -60,
      })
      .run();

    await apply(db, await planKeeping(db, [BRUNCH]));

    expect(row(db, "t_cake")).toMatchObject({
      runAt: "2099-06-20T17:00:00+10:00",
      runTimezone: "Australia/Sydney",
    });
    expect(row(db, "t_kolkata")).toMatchObject({
      runAt: "2099-06-20T17:00:00+05:30",
      runTimezone: "Asia/Kolkata",
    });
  });

  it("commits each removed event's tasks and the event itself in one batch", async () => {
    const db = build();
    // Twelve more events with a linked task each, so the write set runs past
    // one batch and a removed event's statements would straddle it if they
    // were not kept together.
    const now = new Date();
    for (let i = 0; i < 12; i += 1) {
      db.insert(events)
        .values({
          id: `evt_x${i}`,
          weddingId: W,
          slug: `x${i}`,
          name: `X ${i}`,
          startAt: "2099-06-20T12:00:00+10:00",
          endAt: "",
          timezone: "Australia/Sydney",
          sortOrder: 10 + i,
        })
        .run();
      db.insert(tasks)
        .values({
          id: `t_x${i}`,
          weddingId: W,
          title: `X ${i}`,
          timeframeBucket: "day_of",
          createdAt: now,
          eventId: `evt_x${i}`,
          runOffsetMinutes: i,
        })
        .run();
    }
    const plan = await planKeeping(db, [BRUNCH]);
    const chunks: string[][] = [];
    (db as unknown as { batch: (stmts: unknown[]) => Promise<unknown> }).batch = async (stmts) => {
      chunks.push(
        stmts.map((s) => (s as { toSQL: () => { sql: string } }).toSQL().sql.toLowerCase()),
      );
      const out: unknown[] = [];
      for (const s of stmts) out.push(await (s as Promise<unknown>));
      return out;
    };

    await apply(db, plan, ["t_cake"]);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      const freezes = chunk.filter((sql) => sql.startsWith('update "tasks"')).length;
      const deletes = chunk.filter((sql) => sql.startsWith('delete from "events"')).length;
      expect(freezes).toBe(deletes);
    }
    for (let i = 0; i < 12; i += 1) {
      expect(row(db, `t_x${i}`)).toMatchObject({ eventId: null, runTimezone: "Australia/Sydney" });
    }
  });

  it("checks the guest cap on each batch's last guest insert when removed events move the batch edges", async () => {
    const db = build();
    // Thirteen removed events of four or more statements each, packed whole,
    // leave the first batch short of 50; the guests after them then straddle
    // a batch edge that is not at a multiple of 50.
    for (let i = 0; i < 11; i += 1) {
      db.insert(events)
        .values({
          id: `evt_y${i}`,
          weddingId: W,
          slug: `y${i}`,
          name: `Y ${i}`,
          startAt: "2099-06-20T12:00:00+10:00",
          endAt: "",
          timezone: "Australia/Sydney",
          sortOrder: 10 + i,
        })
        .run();
    }
    const removing = await planKeeping(db, [BRUNCH]);
    const families = Array.from({ length: 30 }, (_, i) => ({
      id: `fam_y${i}`,
      publicId: `YFAM-${String(i).padStart(4, "0")}`,
      familyName: `Family ${i}`,
    }));
    const plan: ImportPlan = {
      ...removing,
      familyCreates: families,
      guestCreates: families.map((f, i) => ({
        id: `guest_y${i}`,
        familyId: f.id,
        firstName: `First${i}`,
        lastName: `Last${i}`,
        nickname: null,
        sortOrder: 0,
      })),
    };
    const chunks: string[][] = [];
    (db as unknown as { batch: (stmts: unknown[]) => Promise<unknown> }).batch = async (stmts) => {
      chunks.push(stmts.map((s) => (s as { toSQL: () => { sql: string } }).toSQL().sql));
      const out: unknown[] = [];
      for (const s of stmts) out.push(await (s as Promise<unknown>));
      return out;
    };

    await apply(db, plan);

    expect(chunks[0]!.length).toBeLessThan(50);
    const guestInserts = (sqls: string[]) =>
      sqls.flatMap((q, i) => (q.startsWith('insert into "guests"') ? [i] : []));
    const withGuests = chunks.filter((sqls) => guestInserts(sqls).length > 0);
    expect(withGuests.length).toBeGreaterThan(1);
    for (const sqls of withGuests) {
      const checks = guestInserts(sqls).filter((i) => sqls[i]!.includes("CASE WHEN"));
      expect(checks).toEqual([guestInserts(sqls).at(-1)!]);
    }
  });

  it("keeps every linked task when an older apply with no removal list removes their events", async () => {
    const db = build();
    await apply(db, await planKeeping(db, []));
    for (const id of ["t_sunrise", "t_cake", "t_toast", "t_brunch"]) {
      expect(row(db, id)?.eventId, id).toBeNull();
      expect(row(db, id)?.eventRemovedAt, id).not.toBeNull();
    }
  });
});
