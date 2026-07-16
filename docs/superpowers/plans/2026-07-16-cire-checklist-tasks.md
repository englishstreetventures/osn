# Cire Checklist / Tasks Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a freeform wedding checklist — organisers add tasks, group them by lead-time bucket, check them off, and see an "open tasks" count on the Overview.

**Architecture:** New `tasks` D1 table + per-row CRUD service/route under `/api/organiser/weddings/:weddingId/tasks` (mirrors the organiser-RSVP module — a plain Effect service, not the `changes/*` reconcile pipeline). A new `checklist` module in the organiser IA: sidebar entry, `ChecklistView` screen, weddingId-keyed `tasks-store`, and a live Overview widget replacing the "coming soon" card.

**Tech Stack:** Cloudflare Workers + Elysia (`aot:false`), Effect.ts + Effect Schema (backend only), Drizzle + D1, hand-written numbered SQL migrations, SolidJS (organiser), bun:test + vitest.

## Global Constraints

- **Migrations are hand-written numbered `.sql`** applied by `wrangler d1 migrations apply`. Latest on `main` = `0037_rsvp_consent_source.sql`; this plan adds **`0038_tasks.sql`**. Do NOT run `drizzle-kit generate` (the `_journal.json` is stale).
- **LOCKSTEP DDL invariant (T-S1):** `cire/api/src/db/ddl-lockstep.test.ts` replays the migration chain vs `cire/api/src/db/setup.ts` `DDL` vs `cire/db/src/schema.ts`. All three must agree — every schema change touches all three surfaces in one task.
- **Effect is backend + DB only** — never import `effect` in `cire/organiser` or `cire/web`. Organiser code uses plain Solid primitives.
- **HTTP boundary uses Effect Schema** (`Schema.decodeUnknown`) in cire, not TypeBox. Tagged errors extend `Data.TaggedError`; no thrown exceptions in the service layer.
- **No `console.*` in backend** — use `Effect.logInfo/logWarning/logError`. Never log PII.
- **Changeset required.** All touched packages are `@cire/*` (version-less, ignored) → one **empty** changeset. NEVER mix `@cire/*` with `@osn/api` in a changeset. Package names must match workspace `name` exactly (`@cire/api`, `@cire/db`, `@cire/organiser`).
- **Merging this PR auto-applies `0038` to prod D1** via `deploy.yml` (`d1 migrations apply --remote`). `0038` is a pure additive `CREATE TABLE` on a new empty table — no columns-empty confirmation needed, but the merge still needs explicit per-change user authorization (auto-mode migration guardrail). Do not self-merge.
- **Branch:** `feat/checklist-tasks` (already created). Never commit to `main`. Never `--no-verify` push.
- Run tests with `bun run --cwd cire/api test` (backend) and `bun run --cwd cire/organiser test` (organiser). Type-check with `bun run check`.

---

### Task 1: Schema spine — `tasks` table across all three DDL surfaces

**Files:**
- Create: `cire/db/migrations/0038_tasks.sql`
- Modify: `cire/api/src/db/setup.ts` (append to `DDL`, ends line ~195)
- Modify: `cire/db/src/schema.ts` (add `tasks` table + export)
- Test: `cire/api/src/db/ddl-lockstep.test.ts` (existing — the RED/GREEN gate, not edited)

**Interfaces:**
- Produces: Drizzle table `tasks` exported from `@cire/db` with columns
  `id, weddingId, title, notes, timeframeBucket, dueAt, status, sortOrder, createdAt, completedAt`.
  `createdAt`/`completedAt` are `integer(mode:"timestamp")` (Drizzle returns `Date`).

- [ ] **Step 1: Add the migration (first surface — lockstep now RED)**

Create `cire/db/migrations/0038_tasks.sql`:

```sql
-- Phase 1 Checklist / Tasks ([[platform-plan]] §4.1). A freeform per-wedding
-- task list: the organiser adds tasks and files each under a lead-time bucket
-- (12 months out → day-of). `due_at` is an OPTIONAL date, independent of the
-- bucket — a task can sit in a bucket with or without a specific due date. v1 is
-- freeform (no seeded template) and carries no category/assignee/vendor linkage;
-- those are additive later and don't reshape this table.
--
-- Purely additive: a brand-new table + one index. No rebuild, no data touched.
CREATE TABLE `tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `title` text NOT NULL,
  `notes` text,
  `timeframe_bucket` text NOT NULL,
  `due_at` text,
  `status` text DEFAULT 'open' NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `tasks_wedding_bucket_sort_idx` ON `tasks` (`wedding_id`, `timeframe_bucket`, `sort_order`);
```

- [ ] **Step 2: Run the lockstep test — verify it FAILS**

Run: `bun run --cwd cire/api test -- ddl-lockstep`
Expected: FAIL — the migration chain now has a `tasks` table that `setup.ts` DDL and `schema.ts` do not.

- [ ] **Step 3: Mirror in `setup.ts` DDL (second surface)**

In `cire/api/src/db/setup.ts`, append inside the `DDL` template string, immediately before the closing `` ` `` on line ~195 (after the `imports` table block):

```sql

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  timeframe_bucket TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_wedding_bucket_sort_idx ON tasks(wedding_id, timeframe_bucket, sort_order);
```

- [ ] **Step 4: Mirror in `schema.ts` (third surface)**

In `cire/db/src/schema.ts`, add the table (place after the `events` table for locality; the file already imports `sqliteTable, text, integer, index` from `drizzle-orm/sqlite-core`):

```typescript
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    notes: text("notes"),
    timeframeBucket: text("timeframe_bucket").notNull(),
    // Optional ISO date (YYYY-MM-DD), independent of the bucket.
    dueAt: text("due_at"),
    status: text("status").notNull().default("open"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (t) => [index("tasks_wedding_bucket_sort_idx").on(t.weddingId, t.timeframeBucket, t.sortOrder)],
);
```

- [ ] **Step 5: Run the lockstep test — verify it PASSES**

Run: `bun run --cwd cire/api test -- ddl-lockstep`
Expected: PASS — all three surfaces agree.

- [ ] **Step 6: Apply the migration locally (sanity)**

Run: `cd cire/api && bunx wrangler d1 migrations apply cire-db --local`
Expected: applies `0038_tasks.sql` with no error.

- [ ] **Step 7: Commit**

```bash
git add cire/db/migrations/0038_tasks.sql cire/api/src/db/setup.ts cire/db/src/schema.ts
git commit -m "feat(cire/db): add tasks table (migration 0038)"
```

---

### Task 2: Bucket single-source + HTTP schemas

**Files:**
- Create: `cire/api/src/lib/checklist-buckets.ts`
- Create: `cire/api/src/schemas/tasks.ts`
- Test: `cire/api/src/schemas/tasks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `TIMEFRAME_BUCKETS: readonly {key, label}[]`, `TIMEFRAME_BUCKET_KEYS: readonly string[]`, `type TimeframeBucket`, `isTimeframeBucket(v): v is TimeframeBucket` — from `lib/checklist-buckets.ts`.
  - `CreateTaskBody`, `UpdateTaskBody`, `ReorderTasksBody` Effect Schemas + their `Schema.Schema.Type` aliases — from `schemas/tasks.ts`.

- [ ] **Step 1: Write the failing test**

Create `cire/api/src/schemas/tasks.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";

import { isTimeframeBucket, TIMEFRAME_BUCKET_KEYS } from "../lib/checklist-buckets";
import { CreateTaskBody, ReorderTasksBody, UpdateTaskBody } from "./tasks";

const decode = <A, I>(s: Schema.Schema<A, I>, v: unknown) =>
  Effect.runSync(Effect.either(Schema.decodeUnknown(s)(v)));

describe("checklist buckets", () => {
  it("has the eight ordered lead-time keys", () => {
    expect(TIMEFRAME_BUCKET_KEYS).toEqual([
      "12m",
      "9m",
      "6m",
      "3m",
      "1m",
      "2w",
      "week_of",
      "day_of",
    ]);
  });

  it("recognises valid + rejects unknown buckets", () => {
    expect(isTimeframeBucket("6m")).toBe(true);
    expect(isTimeframeBucket("5m")).toBe(false);
  });
});

describe("CreateTaskBody", () => {
  it("accepts a title + bucket, defaults notes/dueAt to null", () => {
    const r = decode(CreateTaskBody, { title: "Book venue", timeframeBucket: "12m" });
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") {
      expect(r.right.notes).toBeNull();
      expect(r.right.dueAt).toBeNull();
    }
  });

  it("rejects an unknown bucket", () => {
    expect(decode(CreateTaskBody, { title: "x", timeframeBucket: "5m" })._tag).toBe("Left");
  });

  it("rejects an empty title", () => {
    expect(decode(CreateTaskBody, { title: "", timeframeBucket: "6m" })._tag).toBe("Left");
  });
});

describe("UpdateTaskBody", () => {
  it("accepts a partial status flip", () => {
    expect(decode(UpdateTaskBody, { status: "done" })._tag).toBe("Right");
  });

  it("rejects an out-of-set status", () => {
    expect(decode(UpdateTaskBody, { status: "archived" })._tag).toBe("Left");
  });
});

describe("ReorderTasksBody", () => {
  it("accepts a bucket + ordered ids", () => {
    expect(
      decode(ReorderTasksBody, { timeframeBucket: "3m", orderedIds: ["a", "b"] })._tag,
    ).toBe("Right");
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/api test -- schemas/tasks`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the bucket single-source**

Create `cire/api/src/lib/checklist-buckets.ts`:

```typescript
/**
 * The lead-time buckets a checklist task files under, in display order
 * (furthest-out first). Single source of truth for the server: the HTTP schema's
 * bucket enum + any bucket-ordered read derive from THIS list. The organiser
 * client keeps its own label mirror (it can't import cire/api) — keep the two in
 * sync when a bucket is added or a label reworded ([[platform-plan]] §4.1).
 */
export const TIMEFRAME_BUCKETS = [
  { key: "12m", label: "12+ months out" },
  { key: "9m", label: "9 months out" },
  { key: "6m", label: "6 months out" },
  { key: "3m", label: "3 months out" },
  { key: "1m", label: "1 month out" },
  { key: "2w", label: "2 weeks out" },
  { key: "week_of", label: "Week of" },
  { key: "day_of", label: "Day of" },
] as const;

export type TimeframeBucket = (typeof TIMEFRAME_BUCKETS)[number]["key"];

export const TIMEFRAME_BUCKET_KEYS = TIMEFRAME_BUCKETS.map((b) => b.key);

export function isTimeframeBucket(value: string): value is TimeframeBucket {
  return (TIMEFRAME_BUCKET_KEYS as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Write the HTTP schemas**

Create `cire/api/src/schemas/tasks.ts`:

```typescript
import { Schema } from "effect";

import { TIMEFRAME_BUCKETS } from "../lib/checklist-buckets";

const MAX_TITLE_CHARS = 200;
const MAX_NOTES_CHARS = 2000;

// The bucket enum, sourced from the single list so the two never drift.
const bucketKeys = TIMEFRAME_BUCKETS.map((b) => b.key) as [string, ...string[]];
const TimeframeBucketSchema = Schema.Literal(...bucketKeys);

const Title = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_TITLE_CHARS));
const Notes = Schema.String.pipe(Schema.maxLength(MAX_NOTES_CHARS));
// A loose date string (YYYY-MM-DD from the date input). Stored as text; null clears it.
const DueAt = Schema.String.pipe(Schema.maxLength(32));
const Status = Schema.Literal("open", "done");

// Create: title + bucket required; notes/dueAt optional, absent → null.
export const CreateTaskBody = Schema.Struct({
  title: Title,
  timeframeBucket: TimeframeBucketSchema,
  notes: Schema.optionalWith(Schema.NullOr(Notes), { default: () => null }),
  dueAt: Schema.optionalWith(Schema.NullOr(DueAt), { default: () => null }),
});
export type CreateTaskBody = Schema.Schema.Type<typeof CreateTaskBody>;

// Update: every field optional (a partial patch). An absent field is left as-is;
// an explicit null on notes/dueAt clears it.
export const UpdateTaskBody = Schema.Struct({
  title: Schema.optional(Title),
  timeframeBucket: Schema.optional(TimeframeBucketSchema),
  notes: Schema.optional(Schema.NullOr(Notes)),
  dueAt: Schema.optional(Schema.NullOr(DueAt)),
  status: Schema.optional(Status),
  sortOrder: Schema.optional(Schema.Number),
});
export type UpdateTaskBody = Schema.Schema.Type<typeof UpdateTaskBody>;

// Reorder: the new left-to-right order of task ids within one bucket.
export const ReorderTasksBody = Schema.Struct({
  timeframeBucket: TimeframeBucketSchema,
  orderedIds: Schema.Array(Schema.NonEmptyString).pipe(Schema.maxItems(500)),
});
export type ReorderTasksBody = Schema.Schema.Type<typeof ReorderTasksBody>;
```

- [ ] **Step 5: Run the test — verify it PASSES**

Run: `bun run --cwd cire/api test -- schemas/tasks`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cire/api/src/lib/checklist-buckets.ts cire/api/src/schemas/tasks.ts cire/api/src/schemas/tasks.test.ts
git commit -m "feat(cire/api): checklist bucket source + task HTTP schemas"
```

---

### Task 3: Tasks service (CRUD + reorder, wedding-scoped)

**Files:**
- Create: `cire/api/src/services/tasks.ts`
- Test: `cire/api/src/services/tasks.test.ts`

**Interfaces:**
- Consumes: `DbService`, `dbQuery`, `commitBatch` from `../db`; `tasks` from `@cire/db`; `TimeframeBucket` from `../lib/checklist-buckets`.
- Produces:
  - `class TaskNotInWedding extends Data.TaggedError("TaskNotInWedding")`
  - `interface TaskDto { id, weddingId, title, notes: string|null, timeframeBucket, dueAt: string|null, status: "open"|"done", sortOrder, createdAt: number, completedAt: number|null }`
  - `tasksService` object with:
    - `list(weddingId): Effect<TaskDto[], never, DbService>`
    - `create(input: { weddingId, title, timeframeBucket, notes, dueAt }): Effect<TaskDto, never, DbService>`
    - `update(input: { weddingId, taskId, patch }): Effect<TaskDto, TaskNotInWedding, DbService>`
    - `remove(weddingId, taskId): Effect<void, TaskNotInWedding, DbService>`
    - `reorder(weddingId, bucket, orderedIds): Effect<void, never, DbService>`

- [ ] **Step 1: Write the failing test**

Create `cire/api/src/services/tasks.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { BOOTSTRAP_WEDDING_ID, tasks, weddings } from "@cire/db";
import { and, eq } from "drizzle-orm";
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
    const a = await run(db, tasksService.create({
      weddingId: BOOTSTRAP_WEDDING_ID, title: "Book venue", timeframeBucket: "12m", notes: null, dueAt: null,
    }));
    const b = await run(db, tasksService.create({
      weddingId: BOOTSTRAP_WEDDING_ID, title: "Book caterer", timeframeBucket: "12m", notes: null, dueAt: null,
    }));
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
    const created = await run(db, tasksService.create({
      weddingId: BOOTSTRAP_WEDDING_ID, title: "T", timeframeBucket: "6m", notes: null, dueAt: null,
    }));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const id = created.value.id;

    const done = await run(db, tasksService.update({
      weddingId: BOOTSTRAP_WEDDING_ID, taskId: id, patch: { status: "done" },
    }));
    if (!Exit.isSuccess(done)) throw new Error("done failed");
    expect(done.value.status).toBe("done");
    expect(typeof done.value.completedAt).toBe("number");

    const reopened = await run(db, tasksService.update({
      weddingId: BOOTSTRAP_WEDDING_ID, taskId: id, patch: { status: "open" },
    }));
    if (!Exit.isSuccess(reopened)) throw new Error("reopen failed");
    expect(reopened.value.completedAt).toBeNull();
  });

  it("rejects an update to another wedding's task (tenancy)", async () => {
    const db = db0();
    const created = await run(db, tasksService.create({
      weddingId: BOOTSTRAP_WEDDING_ID, title: "T", timeframeBucket: "6m", notes: null, dueAt: null,
    }));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const res = await run(db, tasksService.update({
      weddingId: OTHER, taskId: created.value.id, patch: { title: "hijack" },
    }));
    expect(Exit.isFailure(res)).toBe(true);
    if (Exit.isFailure(res)) {
      expect(res.cause._tag === "Fail" && res.cause.error instanceof TaskNotInWedding).toBe(true);
    }
    // The task is untouched.
    const row = db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, created.value.id)).get();
    expect(row?.title).toBe("T");
  });

  it("rejects deleting another wedding's task and deletes its own", async () => {
    const db = db0();
    const created = await run(db, tasksService.create({
      weddingId: BOOTSTRAP_WEDDING_ID, title: "T", timeframeBucket: "6m", notes: null, dueAt: null,
    }));
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
      const r = await run(db, tasksService.create({
        weddingId: BOOTSTRAP_WEDDING_ID, title, timeframeBucket: "3m", notes: null, dueAt: null,
      }));
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
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/api test -- services/tasks`
Expected: FAIL — `./tasks` not found.

- [ ] **Step 3: Write the service**

Create `cire/api/src/services/tasks.ts`:

```typescript
/**
 * Checklist tasks (platform Phase 1, [[platform-plan]] §4.1) — per-row CRUD over
 * a wedding's freeform task list. Deliberately its OWN service, NOT routed
 * through `changes/*`: tasks sit outside the guest/schedule reconcile pipeline.
 *
 * TENANCY: the route gate (`weddingEditor()`/`weddingMember()`) proves the caller
 * may touch `weddingId`. Every write here ADDITIONALLY scopes by `wedding_id` in
 * the WHERE clause, so an editor of wedding A can never mutate wedding B's task
 * even with a leaked task id — a mismatched (weddingId, taskId) fails
 * `TaskNotInWedding` rather than touching a row.
 */
import { tasks } from "@cire/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { TimeframeBucket } from "../lib/checklist-buckets";

/** No task with this id under this wedding (missing or another wedding's). 404-class. */
export class TaskNotInWedding extends Data.TaggedError("TaskNotInWedding") {}

export type TaskStatus = "open" | "done";

export interface TaskDto {
  id: string;
  weddingId: string;
  title: string;
  notes: string | null;
  timeframeBucket: string;
  dueAt: string | null;
  status: TaskStatus;
  sortOrder: number;
  /** ms epoch. */
  createdAt: number;
  /** ms epoch, or null while open. */
  completedAt: number | null;
}

export interface CreateTaskInput {
  weddingId: string;
  title: string;
  timeframeBucket: TimeframeBucket;
  notes: string | null;
  dueAt: string | null;
}

export interface UpdateTaskPatch {
  title?: string;
  timeframeBucket?: TimeframeBucket;
  notes?: string | null;
  dueAt?: string | null;
  status?: TaskStatus;
  sortOrder?: number;
}

interface TaskRow {
  id: string;
  weddingId: string;
  title: string;
  notes: string | null;
  timeframeBucket: string;
  dueAt: string | null;
  status: string;
  sortOrder: number;
  createdAt: Date;
  completedAt: Date | null;
}

const toDto = (r: TaskRow): TaskDto => ({
  id: r.id,
  weddingId: r.weddingId,
  title: r.title,
  notes: r.notes,
  timeframeBucket: r.timeframeBucket,
  dueAt: r.dueAt,
  status: r.status === "done" ? "done" : "open",
  sortOrder: r.sortOrder,
  createdAt: r.createdAt.getTime(),
  completedAt: r.completedAt ? r.completedAt.getTime() : null,
});

export const tasksService = {
  list(weddingId: string): Effect.Effect<TaskDto[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select()
          .from(tasks)
          .where(eq(tasks.weddingId, weddingId))
          .orderBy(asc(tasks.timeframeBucket), asc(tasks.sortOrder))
          .all(),
      );
      return (rows as TaskRow[]).map(toDto);
    }).pipe(Effect.withSpan("cire.tasks.list"));
  },

  create(input: CreateTaskInput): Effect.Effect<TaskDto, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Append to the end of the bucket: next sort_order = current max + 1.
      const [agg] = yield* dbQuery(() =>
        db
          .select({ max: sql<number | null>`max(${tasks.sortOrder})` })
          .from(tasks)
          .where(
            and(eq(tasks.weddingId, input.weddingId), eq(tasks.timeframeBucket, input.timeframeBucket)),
          )
          .all(),
      );
      const sortOrder = (agg?.max ?? -1) + 1;
      const id = `tsk_${crypto.randomUUID()}`;
      const now = new Date();
      const row: TaskRow = {
        id,
        weddingId: input.weddingId,
        title: input.title,
        notes: input.notes,
        timeframeBucket: input.timeframeBucket,
        dueAt: input.dueAt,
        status: "open",
        sortOrder,
        createdAt: now,
        completedAt: null,
      };
      yield* dbQuery(() => db.insert(tasks).values(row).run());
      return toDto(row);
    }).pipe(Effect.withSpan("cire.tasks.create"));
  },

  update(input: {
    weddingId: string;
    taskId: string;
    patch: UpdateTaskPatch;
  }): Effect.Effect<TaskDto, TaskNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, taskId, patch } = input;

      const [existing] = yield* dbQuery(() =>
        db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
          .all(),
      );
      if (!existing) return yield* Effect.fail(new TaskNotInWedding());

      const set: Partial<TaskRow> = {};
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.timeframeBucket !== undefined) set.timeframeBucket = patch.timeframeBucket;
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
      if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
      if (patch.status !== undefined) {
        set.status = patch.status;
        // done stamps completed_at; reopening clears it.
        set.completedAt = patch.status === "done" ? new Date() : null;
      }

      yield* dbQuery(() =>
        db
          .update(tasks)
          .set(set)
          .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
          .run(),
      );

      const [updated] = yield* dbQuery(() =>
        db.select().from(tasks).where(eq(tasks.id, taskId)).all(),
      );
      return toDto(updated as TaskRow);
    }).pipe(Effect.withSpan("cire.tasks.update"));
  },

  remove(weddingId: string, taskId: string): Effect.Effect<void, TaskNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [existing] = yield* dbQuery(() =>
        db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId)))
          .all(),
      );
      if (!existing) return yield* Effect.fail(new TaskNotInWedding());
      yield* dbQuery(() =>
        db.delete(tasks).where(and(eq(tasks.id, taskId), eq(tasks.weddingId, weddingId))).run(),
      );
    }).pipe(Effect.withSpan("cire.tasks.remove"));
  },

  reorder(
    weddingId: string,
    bucket: TimeframeBucket,
    orderedIds: readonly string[],
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Each id gets its array index as sort_order, scoped to (wedding, bucket)
      // so a foreign or wrong-bucket id is a no-op UPDATE rather than a write.
      yield* dbQuery(() =>
        db.transaction((tx) => {
          orderedIds.forEach((id, index) => {
            tx.update(tasks)
              .set({ sortOrder: index })
              .where(
                and(
                  eq(tasks.id, id),
                  eq(tasks.weddingId, weddingId),
                  eq(tasks.timeframeBucket, bucket),
                ),
              )
              .run();
          });
        }),
      );
    }).pipe(Effect.withSpan("cire.tasks.reorder"));
  },
};
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `bun run --cwd cire/api test -- services/tasks`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add cire/api/src/services/tasks.ts cire/api/src/services/tasks.test.ts
git commit -m "feat(cire/api): tasks service (wedding-scoped CRUD + reorder)"
```

---

### Task 4: Tasks routes + mount

**Files:**
- Create: `cire/api/src/routes/tasks.ts`
- Modify: `cire/api/src/app.ts` (import + `.use(...)` near line 316, beside `createOrganiserRsvpRoutes`)
- Test: `cire/api/src/routes/tasks.test.ts`

**Interfaces:**
- Consumes: `tasksService`, `TaskNotInWedding` (Task 3); `CreateTaskBody`, `UpdateTaskBody`, `ReorderTasksBody` (Task 2); `weddingMember`, `weddingEditor`, `osnAuth`, `runCire`, `DbService`.
- Produces: `createTaskRoutes(db, osnAuthOptions)` Elysia factory. Endpoints under `/api/organiser/weddings/:weddingId`:
  - `GET /tasks` → `{ tasks: TaskDto[] }` (weddingMember)
  - `POST /tasks` → `{ task: TaskDto }` (weddingEditor)
  - `PATCH /tasks/:taskId` → `{ task: TaskDto }` (weddingEditor)
  - `DELETE /tasks/:taskId` → `{ ok: true }` (weddingEditor)
  - `PATCH /tasks/reorder` → `{ ok: true }` (weddingEditor)

- [ ] **Step 1: Write the failing test**

Create `cire/api/src/routes/tasks.test.ts`:

```typescript
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
  db.insert(weddingHosts).values({
    id: "whost_editor", weddingId: BOOTSTRAP_WEDDING_ID, osnProfileId: EDITOR,
    addedByOsnProfileId: OWNER, role: "editor", createdAt: now,
  }).run();
  db.insert(weddingHosts).values({
    id: "whost_viewer", weddingId: BOOTSTRAP_WEDDING_ID, osnProfileId: VIEWER,
    addedByOsnProfileId: OWNER, role: "viewer", createdAt: now,
  }).run();
  db.insert(weddings).values({
    id: "wed_other", slug: "other-wedding", displayName: "Other",
    ownerOsnProfileId: "usr_bob", createdAt: now, updatedAt: now,
  }).run();
  return createApp(db, { osnTestKey: auth.key });
}
type App = ReturnType<typeof buildApp>;

async function req(
  app: App, method: string, path: string, profileId: string | undefined, body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
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
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/api test -- routes/tasks`
Expected: FAIL — routes not mounted (GET returns 404, not 200/401 as asserted).

- [ ] **Step 3: Write the routes**

Create `cire/api/src/routes/tasks.ts`:

```typescript
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import { CreateTaskBody, ReorderTasksBody, UpdateTaskBody } from "../schemas/tasks";
import { tasksService } from "../services/tasks";

// Sentinel parse hook — same idiom as the other organiser write routes: the
// handler parses by hand so a malformed payload degrades to the schema's 400.
const manualParse = { parse: () => ({}) };

const notFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "task_not_found" };
  });

const badRequest = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 400;
    return { error: "Missing or invalid fields" };
  });

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

/**
 * Checklist tasks (platform Phase 1, [[platform-plan]] §4.1):
 *
 *   GET    /api/organiser/weddings/:weddingId/tasks           (weddingMember)
 *   POST   /api/organiser/weddings/:weddingId/tasks           (weddingEditor)
 *   PATCH  /api/organiser/weddings/:weddingId/tasks/reorder   (weddingEditor)
 *   PATCH  /api/organiser/weddings/:weddingId/tasks/:taskId   (weddingEditor)
 *   DELETE /api/organiser/weddings/:weddingId/tasks/:taskId   (weddingEditor)
 *
 * The first real `/tasks/*` module-router — a NEW surface, mounted directly (no
 * `changes/*` alias). Reads are any-role (`weddingMember()`); writes are
 * editor-or-owner (`weddingEditor()`; a viewer gets 403 `read_only_role`). The
 * service re-scopes every write by wedding_id, so a cross-tenant id 404s.
 *
 * NOTE the `/tasks/reorder` route is registered BEFORE `/tasks/:taskId` so the
 * literal wins over the param.
 */
export const createTaskRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) => {
  return new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        // Reads — any member role.
        .guard((read) =>
          read.use(weddingMember(db)).get("/tasks", async ({ weddingId, set }) => {
            if (!weddingId) return internalSync(set);
            return runCire(
              tasksService
                .list(weddingId)
                .pipe(
                  Effect.map((list) => ({ tasks: list })),
                  Effect.provideService(DbService, db),
                  Effect.catchAllDefect(() => internal(set)),
                ),
            );
          }),
        )
        // Writes — editor or owner.
        .guard((write) =>
          write
            .use(weddingEditor(db))
            .post(
              "/tasks",
              async ({ weddingId, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(CreateTaskBody)(raw);
                    const task = yield* tasksService.create({
                      weddingId,
                      title: body.title,
                      timeframeBucket: body.timeframeBucket,
                      notes: body.notes,
                      dueAt: body.dueAt,
                    });
                    return { task };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .patch(
              "/tasks/reorder",
              async ({ weddingId, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(ReorderTasksBody)(raw);
                    yield* tasksService.reorder(weddingId, body.timeframeBucket, body.orderedIds);
                    return { ok: true as const };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .patch(
              "/tasks/:taskId",
              async ({ weddingId, params, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(UpdateTaskBody)(raw);
                    const task = yield* tasksService.update({
                      weddingId,
                      taskId: params.taskId,
                      patch: body,
                    });
                    return { task };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchTag("TaskNotInWedding", () => notFound(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .delete("/tasks/:taskId", async ({ weddingId, params, set }) => {
              if (!weddingId) return internalSync(set);
              return runCire(
                tasksService
                  .remove(weddingId, params.taskId)
                  .pipe(
                    Effect.map(() => ({ ok: true as const })),
                    Effect.provideService(DbService, db),
                    Effect.catchTag("TaskNotInWedding", () => notFound(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
              );
            }),
        ),
    );
};

// A non-Effect 500 for the (unreachable) missing-weddingId guard.
function internalSync(set: { status?: number | string }) {
  set.status = 500;
  return { error: "Internal error" };
}
```

- [ ] **Step 4: Mount the routes in `app.ts`**

Add the import beside the other organiser route imports (near line 21):

```typescript
import { createTaskRoutes } from "./routes/tasks";
```

Add the `.use(...)` in the organiser route chain, immediately after the `createOrganiserRsvpRoutes` line (~316):

```typescript
      .use(createOrganiserRsvpRoutes(db, osnAuthOptions))
      .use(createTaskRoutes(db, osnAuthOptions))
```

- [ ] **Step 5: Run the test — verify it PASSES**

Run: `bun run --cwd cire/api test -- routes/tasks`
Expected: PASS (all 7 cases).

- [ ] **Step 6: Run the whole cire/api suite (guard against a route-ordering regression)**

Run: `bun run --cwd cire/api test`
Expected: PASS — including `ddl-lockstep` and the existing organiser-rsvp tests.

- [ ] **Step 7: Commit**

```bash
git add cire/api/src/routes/tasks.ts cire/api/src/routes/tasks.test.ts cire/api/src/app.ts
git commit -m "feat(cire/api): tasks routes mounted under /api/organiser/.../tasks"
```

---

### Task 5: Organiser bucket mirror + tasks-store

**Files:**
- Create: `cire/organiser/src/lib/checklist-buckets.ts`
- Create: `cire/organiser/src/lib/tasks-store.ts`
- Test: `cire/organiser/src/lib/tasks-store.test.ts`

**Interfaces:**
- Consumes: nothing (plain Solid).
- Produces:
  - `TIMEFRAME_BUCKETS: readonly {key, label}[]`, `type TimeframeBucket` — client label mirror.
  - `interface TaskRow { id, weddingId, title, notes, timeframeBucket, dueAt, status, sortOrder, createdAt, completedAt }` (timestamps as `number`/`null`, matching the API DTO JSON).
  - Store fns: `tasksAccessor(weddingId): Accessor<TaskRow[] | null>`, `hasCachedTasks`, `setCachedTasks`, `peekCachedTasks`, `invalidateTasks`, `ensureTasksLoaded(weddingId, fetcher)`, `openTaskCount(weddingId): number | null`, `__resetTasksCache()`.

- [ ] **Step 1: Write the failing test**

Create `cire/organiser/src/lib/tasks-store.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetTasksCache,
  ensureTasksLoaded,
  openTaskCount,
  type TaskRow,
  tasksAccessor,
} from "./tasks-store";

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "tsk_1",
  weddingId: "wed_1",
  title: "T",
  notes: null,
  timeframeBucket: "6m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  ...over,
});

beforeEach(() => __resetTasksCache());

describe("tasks-store", () => {
  it("loads once and reuses the cache", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [row({})];
    };
    await ensureTasksLoaded("wed_1", fetcher);
    await ensureTasksLoaded("wed_1", fetcher);
    expect(calls).toBe(1);
    expect(tasksAccessor("wed_1")()?.length).toBe(1);
  });

  it("openTaskCount counts only open tasks, null before load", async () => {
    expect(openTaskCount("wed_1")).toBeNull();
    await ensureTasksLoaded("wed_1", async () => [
      row({ id: "a", status: "open" }),
      row({ id: "b", status: "done" }),
      row({ id: "c", status: "open" }),
    ]);
    expect(openTaskCount("wed_1")).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/organiser test -- tasks-store`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the bucket mirror**

Create `cire/organiser/src/lib/checklist-buckets.ts`:

```typescript
// Client mirror of the server's checklist bucket list
// (cire/api/src/lib/checklist-buckets.ts). The organiser can't import cire/api,
// so the labels + order live here too — keep the two in sync when a bucket is
// added or a label reworded ([[platform-plan]] §4.1).
export const TIMEFRAME_BUCKETS = [
  { key: "12m", label: "12+ months out" },
  { key: "9m", label: "9 months out" },
  { key: "6m", label: "6 months out" },
  { key: "3m", label: "3 months out" },
  { key: "1m", label: "1 month out" },
  { key: "2w", label: "2 weeks out" },
  { key: "week_of", label: "Week of" },
  { key: "day_of", label: "Day of" },
] as const;

export type TimeframeBucket = (typeof TIMEFRAME_BUCKETS)[number]["key"];
```

- [ ] **Step 4: Write the store**

Create `cire/organiser/src/lib/tasks-store.ts`:

```typescript
// A `weddingId`-keyed cache for the organiser's checklist tasks — the sibling of
// `guests-store.ts`/`events-store.ts`. Same fetch-lift so switching modules
// doesn't refetch, and so the Overview "open tasks" widget and the Checklist
// view share ONE fetch. Effect is deliberately NOT imported (frontend code).
import { type Accessor, createSignal, type Setter } from "solid-js";

/** One task row as the organiser API returns it (timestamps are ms-epoch numbers). */
export interface TaskRow {
  id: string;
  weddingId: string;
  title: string;
  notes: string | null;
  timeframeBucket: string;
  dueAt: string | null;
  status: "open" | "done";
  sortOrder: number;
  createdAt: number;
  completedAt: number | null;
}

interface CacheEntry {
  tasks: Accessor<TaskRow[] | null>;
  setTasks: Setter<TaskRow[] | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [tasks, setTasks] = createSignal<TaskRow[] | null>(null);
    entry = { tasks, setTasks };
    cache.set(weddingId, entry);
  }
  return entry;
}

export function tasksAccessor(weddingId: string): Accessor<TaskRow[] | null> {
  return entryFor(weddingId).tasks;
}

export function hasCachedTasks(weddingId: string): boolean {
  return cache.get(weddingId)?.tasks() != null;
}

export function setCachedTasks(weddingId: string, tasks: TaskRow[]): void {
  entryFor(weddingId).setTasks(tasks);
}

export function peekCachedTasks(weddingId: string): TaskRow[] | null {
  return cache.get(weddingId)?.tasks() ?? null;
}

export function invalidateTasks(weddingId: string): void {
  cache.delete(weddingId);
}

/** Reactive open-task count for the Overview widget: `null` until first load. */
export function openTaskCount(weddingId: string): number | null {
  const rows = entryFor(weddingId).tasks();
  if (rows == null) return null;
  return rows.filter((t) => t.status === "open").length;
}

const inflight = new Map<string, Promise<void>>();

export function ensureTasksLoaded(
  weddingId: string,
  fetcher: () => Promise<TaskRow[]>,
): Promise<void> {
  if (hasCachedTasks(weddingId)) return Promise.resolve();
  let pending = inflight.get(weddingId);
  if (!pending) {
    pending = fetcher()
      .then((rows) => {
        setCachedTasks(weddingId, rows);
      })
      .finally(() => inflight.delete(weddingId));
    inflight.set(weddingId, pending);
  }
  return pending;
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetTasksCache(): void {
  cache.clear();
  inflight.clear();
}
```

- [ ] **Step 5: Run the test — verify it PASSES**

Run: `bun run --cwd cire/organiser test -- tasks-store`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cire/organiser/src/lib/checklist-buckets.ts cire/organiser/src/lib/tasks-store.ts cire/organiser/src/lib/tasks-store.test.ts
git commit -m "feat(cire/organiser): checklist bucket mirror + tasks-store cache"
```

---

### Task 6: ChecklistView component

**Files:**
- Create: `cire/organiser/src/components/ChecklistView.tsx`
- Test: `cire/organiser/src/components/ChecklistView.test.tsx`

**Interfaces:**
- Consumes: `TIMEFRAME_BUCKETS`, `TimeframeBucket` (Task 5); tasks-store fns (Task 5); `apiUrl`, `isAuthExpired`, `redirectToLogin` from `../lib/api`; `useAuth` from `@osn/client/solid`.
- Produces: `export default function ChecklistView(props: { weddingId: string; canEdit?: boolean })`.

**Note on the write helpers:** the component owns its own optimistic mutations. After any successful create/patch/delete/reorder it re-sets the cache via `setCachedTasks` so the Overview widget and a later remount stay consistent. On a write failure it reloads from the server (`invalidateTasks` + refetch).

- [ ] **Step 1: Write the failing test**

Create `cire/organiser/src/components/ChecklistView.test.tsx`:

```typescript
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetTasksCache, setCachedTasks, type TaskRow } from "../lib/tasks-store";
import ChecklistView from "./ChecklistView";

// useAuth: a stub authFetch we drive per-test.
const authFetch = vi.fn();
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "tsk_1", weddingId: "wed_1", title: "Book venue", notes: null,
  timeframeBucket: "12m", dueAt: null, status: "open", sortOrder: 0,
  createdAt: 1, completedAt: null, ...over,
});

beforeEach(() => {
  __resetTasksCache();
  authFetch.mockReset();
});

describe("ChecklistView", () => {
  it("groups tasks under their bucket headings", async () => {
    // Seed the cache so the view renders without a network round-trip.
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue", timeframeBucket: "12m" })]);
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    expect(await screen.findByText("Book venue")).toBeInTheDocument();
    expect(screen.getByText("12+ months out")).toBeInTheDocument();
  });

  it("hides all write controls for a viewer (read-only)", async () => {
    setCachedTasks("wed_1", [row({ id: "a" })]);
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);
    await screen.findByText("Book venue");
    expect(screen.queryByRole("button", { name: /add task/i })).not.toBeInTheDocument();
  });

  it("checks a task off (PATCH status done) and updates the row", async () => {
    setCachedTasks("wed_1", [row({ id: "a", status: "open" })]);
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: row({ id: "a", status: "done", completedAt: 2 }) }), {
        status: 200,
      }),
    );
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const checkbox = await screen.findByRole("checkbox", { name: /book venue/i });
    fireEvent.click(checkbox);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [, init] = authFetch.mock.calls[0]!;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "done" });
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/organiser test -- ChecklistView`
Expected: FAIL — component not found.

- [ ] **Step 3: Write the component**

Create `cire/organiser/src/components/ChecklistView.tsx`. This implements: load-once via the store, bucket-grouped sections, an add-task form (editor only), inline check-off, delete, and within-bucket move-up/down reorder (buttons — matches the events-editor "move controls" idiom; no drag library dependency). All writes are optimistic with a server reconcile.

```typescript
import { useAuth } from "@osn/client/solid";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { TIMEFRAME_BUCKETS, type TimeframeBucket } from "../lib/checklist-buckets";
import {
  ensureTasksLoaded,
  invalidateTasks,
  peekCachedTasks,
  setCachedTasks,
  type TaskRow,
  tasksAccessor,
} from "../lib/tasks-store";

interface ChecklistViewProps {
  weddingId: string;
  /** Owner/editor may add, edit, complete, reorder; a viewer sees a read-only list. */
  canEdit?: boolean;
}

export default function ChecklistView(props: ChecklistViewProps) {
  const { authFetch } = useAuth();
  const tasks = tasksAccessor(props.weddingId);
  const [error, setError] = createSignal<string | null>(null);
  const [newTitle, setNewTitle] = createSignal("");
  const [newBucket, setNewBucket] = createSignal<TimeframeBucket>(TIMEFRAME_BUCKETS[0]!.key);
  const [newDue, setNewDue] = createSignal("");

  const listUrl = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks`);

  const load = async (): Promise<TaskRow[]> => {
    const res = await authFetch(listUrl());
    if (res.status === 401) {
      redirectToLogin();
      return [];
    }
    if (!res.ok) throw new Error(`Failed to load checklist (${res.status})`);
    return ((await res.json()) as { tasks: TaskRow[] }).tasks;
  };

  onMount(() => {
    ensureTasksLoaded(props.weddingId, load).catch((err) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't load your checklist. Refresh to try again.");
    });
  });

  // Refetch from the server and repopulate the cache (used after a write fails).
  const reload = async () => {
    invalidateTasks(props.weddingId);
    try {
      setCachedTasks(props.weddingId, await load());
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't refresh your checklist.");
    }
  };

  // Tasks grouped by bucket, each list already sort_order-ascending from the API.
  const grouped = createMemo(() => {
    const rows = tasks() ?? [];
    return TIMEFRAME_BUCKETS.map((b) => ({
      bucket: b,
      items: rows
        .filter((t) => t.timeframeBucket === b.key)
        .sort((a, c) => a.sortOrder - c.sortOrder),
    }));
  });

  const patchCache = (next: TaskRow[]) => setCachedTasks(props.weddingId, next);

  const addTask = async (e: Event) => {
    e.preventDefault();
    const title = newTitle().trim();
    if (!title) return;
    setError(null);
    const body = {
      title,
      timeframeBucket: newBucket(),
      dueAt: newDue() || null,
    };
    setNewTitle("");
    setNewDue("");
    try {
      const res = await authFetch(listUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`create ${res.status}`);
      const { task } = (await res.json()) as { task: TaskRow };
      patchCache([...(peekCachedTasks(props.weddingId) ?? []), task]);
    } catch {
      setError("Couldn't add that task.");
      void reload();
    }
  };

  const toggleDone = async (task: TaskRow) => {
    const nextStatus = task.status === "done" ? "open" : "done";
    // Optimistic flip.
    patchCache(
      (peekCachedTasks(props.weddingId) ?? []).map((t) =>
        t.id === task.id ? { ...t, status: nextStatus } : t,
      ),
    );
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks/${task.id}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`patch ${res.status}`);
      const { task: updated } = (await res.json()) as { task: TaskRow };
      patchCache(
        (peekCachedTasks(props.weddingId) ?? []).map((t) => (t.id === updated.id ? updated : t)),
      );
    } catch {
      setError("Couldn't update that task.");
      void reload();
    }
  };

  const deleteTask = async (task: TaskRow) => {
    patchCache((peekCachedTasks(props.weddingId) ?? []).filter((t) => t.id !== task.id));
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks/${task.id}`),
        { method: "DELETE" },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`delete ${res.status}`);
    } catch {
      setError("Couldn't delete that task.");
      void reload();
    }
  };

  // Move a task up/down within its bucket, then persist the new order.
  const move = async (bucket: TimeframeBucket, index: number, delta: -1 | 1) => {
    const items = (peekCachedTasks(props.weddingId) ?? [])
      .filter((t) => t.timeframeBucket === bucket)
      .sort((a, c) => a.sortOrder - c.sortOrder);
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    // Rewrite sort_order locally + in the cache.
    const orderedIds = reordered.map((t) => t.id);
    const bySort = new Map(orderedIds.map((id, i) => [id, i]));
    patchCache(
      (peekCachedTasks(props.weddingId) ?? []).map((t) =>
        t.timeframeBucket === bucket ? { ...t, sortOrder: bySort.get(t.id) ?? t.sortOrder } : t,
      ),
    );
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks/reorder`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timeframeBucket: bucket, orderedIds }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`reorder ${res.status}`);
    } catch {
      setError("Couldn't save the new order.");
      void reload();
    }
  };

  return (
    <div class="flex flex-col gap-6">
      <Show when={error()}>
        <p class="border-error/40 text-error rounded-sm border px-3 py-2 text-[0.82rem]">
          {error()}
        </p>
      </Show>

      <Show when={props.canEdit}>
        <form
          onSubmit={addTask}
          class="border-border bg-surface/20 flex flex-wrap items-end gap-3 rounded-sm border p-4"
        >
          <label class="flex min-w-[12rem] flex-1 flex-col gap-1">
            <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
              Task
            </span>
            <input
              type="text"
              value={newTitle()}
              onInput={(e) => setNewTitle(e.currentTarget.value)}
              placeholder="Book the venue"
              class="border-border bg-bg text-text rounded-sm border px-3 py-2 text-[0.9rem]"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
              When
            </span>
            <select
              value={newBucket()}
              onChange={(e) => setNewBucket(e.currentTarget.value as TimeframeBucket)}
              class="border-border bg-bg text-text rounded-sm border px-3 py-2 text-[0.9rem]"
            >
              <For each={TIMEFRAME_BUCKETS}>
                {(b) => <option value={b.key}>{b.label}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
              Due (optional)
            </span>
            <input
              type="date"
              value={newDue()}
              onInput={(e) => setNewDue(e.currentTarget.value)}
              class="border-border bg-bg text-text rounded-sm border px-3 py-2 text-[0.9rem]"
            />
          </label>
          <button
            type="submit"
            class="bg-gold text-bg rounded-sm px-4 py-2 text-[0.82rem] tracking-[0.08em] uppercase"
          >
            Add task
          </button>
        </form>
      </Show>

      <For each={grouped()}>
        {(group) => (
          <section class="flex flex-col gap-2">
            <h3 class="text-gold-dim font-body text-[0.7rem] tracking-[0.18em] uppercase">
              {group.bucket.label}
            </h3>
            <Show
              when={group.items.length > 0}
              fallback={
                <p class="text-text-muted text-[0.8rem] italic">Nothing here yet.</p>
              }
            >
              <ul class="flex flex-col gap-1">
                <For each={group.items}>
                  {(task, i) => (
                    <li class="border-border bg-surface/10 flex items-center gap-3 rounded-sm border px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={task.title}
                        checked={task.status === "done"}
                        disabled={!props.canEdit}
                        onChange={() => props.canEdit && toggleDone(task)}
                      />
                      <span
                        class={`flex-1 text-[0.9rem] ${
                          task.status === "done" ? "text-text-muted line-through" : "text-text"
                        }`}
                      >
                        {task.title}
                        <Show when={task.dueAt}>
                          <span class="text-text-muted ml-2 text-[0.72rem]">· due {task.dueAt}</span>
                        </Show>
                      </span>
                      <Show when={props.canEdit}>
                        <div class="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="Move up"
                            disabled={i() === 0}
                            onClick={() => move(group.bucket.key, i(), -1)}
                            class="text-text-muted hover:text-text px-1 disabled:opacity-30"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label="Move down"
                            disabled={i() === group.items.length - 1}
                            onClick={() => move(group.bucket.key, i(), 1)}
                            class="text-text-muted hover:text-text px-1 disabled:opacity-30"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            aria-label="Delete task"
                            onClick={() => deleteTask(task)}
                            class="text-text-muted hover:text-error px-1"
                          >
                            ✕
                          </button>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </For>
    </div>
  );
}
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `bun run --cwd cire/organiser test -- ChecklistView`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add cire/organiser/src/components/ChecklistView.tsx cire/organiser/src/components/ChecklistView.test.tsx
git commit -m "feat(cire/organiser): ChecklistView (bucket-grouped tasks, editor writes)"
```

---

### Task 7: Wire `checklist` into the module IA

**Files:**
- Modify: `cire/organiser/src/lib/dashboard-route.ts` (`MODULES`, `MODULE_SUBS`)
- Modify: `cire/organiser/src/components/ModuleSidebar.tsx` (`MODULE_NAV`)
- Modify: `cire/organiser/src/components/ModuleShell.tsx` (import + render branch)
- Test: `cire/organiser/src/lib/dashboard-route.test.ts` (extend existing if present; else create)

**Interfaces:**
- Consumes: `ChecklistView` (Task 6).
- Produces: `"checklist"` is a valid `Module`; `#/w/<id>/checklist` parses to it; the sidebar shows it; the shell renders `ChecklistView`.

- [ ] **Step 1: Write the failing test**

Add to `cire/organiser/src/lib/dashboard-route.test.ts` (create the file with this content if it does not exist):

```typescript
import { describe, expect, it } from "vitest";

import { isModule, MODULES, parseRoute, serializeRoute } from "./dashboard-route";

describe("checklist module route", () => {
  it("checklist is a known module", () => {
    expect(isModule("checklist")).toBe(true);
    expect(MODULES).toContain("checklist");
  });

  it("parses #/w/<id>/checklist to the checklist module", () => {
    const r = parseRoute("#/w/wed_1/checklist");
    expect(r.view).toBe("weddings");
    if (r.view === "weddings") {
      expect(r.weddingId).toBe("wed_1");
      expect(r.module).toBe("checklist");
    }
  });

  it("serializes a checklist route back to the canonical hash", () => {
    expect(
      serializeRoute({ view: "weddings", weddingId: "wed_1", module: "checklist", sub: "index" }),
    ).toBe("#/w/wed_1/checklist");
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/organiser test -- dashboard-route`
Expected: FAIL — `isModule("checklist")` is false.

- [ ] **Step 3: Register the module in `dashboard-route.ts`**

Add `"checklist"` to `MODULES` (place it after `guests`, before `schedule` is fine — order is sidebar order; put checklist right after schedule to sit with planning). Use this exact order:

```typescript
export const MODULES = ["overview", "schedule", "checklist", "guests", "invite", "settings"] as const;
```

Add its single implicit sub to `MODULE_SUBS`:

```typescript
export const MODULE_SUBS: Record<Module, readonly string[]> = {
  overview: ["index"],
  schedule: ["list", "edit"],
  checklist: ["index"],
  guests: ["list", "edit", "rsvps"],
  invite: ["design", "codes"],
  settings: ["wedding", "hosts"],
};
```

- [ ] **Step 4: Add the sidebar entry in `ModuleSidebar.tsx`**

Add to `MODULE_NAV` (keep it in the same order as `MODULES`):

```typescript
  { id: "checklist", label: "Checklist", glyph: "✓", hint: "Your planning tasks by lead time" },
```

Place the entry between the `schedule` and `guests` rows.

- [ ] **Step 5: Render the module in `ModuleShell.tsx`**

Add the import beside the others:

```typescript
import ChecklistView from "./ChecklistView";
```

Add the render branch after the Schedule block (checklist has no sub-tabs, like Overview):

```tsx
        {/* ── Checklist: freeform tasks by lead-time bucket ────────────── */}
        <Show when={props.module === "checklist"}>
          <ChecklistView weddingId={props.weddingId} canEdit={props.canEdit} />
        </Show>
```

- [ ] **Step 6: Run the test — verify it PASSES**

Run: `bun run --cwd cire/organiser test -- dashboard-route`
Expected: PASS.

- [ ] **Step 7: Type-check the organiser package (the `Module` union widened — catch any exhaustiveness gap)**

Run: `bun run --cwd cire/organiser check` (or `bun run check` from root)
Expected: PASS — no missing-case errors. (If `Overview`'s `onNavigate` type or any `Record<Module, …>` complains, it is handled in Task 8 / is already total.)

- [ ] **Step 8: Commit**

```bash
git add cire/organiser/src/lib/dashboard-route.ts cire/organiser/src/lib/dashboard-route.test.ts cire/organiser/src/components/ModuleSidebar.tsx cire/organiser/src/components/ModuleShell.tsx
git commit -m "feat(cire/organiser): register checklist module in the IA shell"
```

---

### Task 8: Live "open tasks" Overview widget

**Files:**
- Modify: `cire/organiser/src/components/Overview.tsx` (replace the Checklist `SnapshotComingSoon`; widen `onNavigate`)
- Test: `cire/organiser/src/components/Overview.checklist.test.tsx`

**Interfaces:**
- Consumes: `ensureTasksLoaded`, `openTaskCount`, `type TaskRow` (Task 5).
- Produces: the Overview Checklist card shows a live open-task count and navigates to the checklist module on click.

- [ ] **Step 1: Write the failing test**

Create `cire/organiser/src/components/Overview.checklist.test.tsx`:

```typescript
import { render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetTasksCache, setCachedTasks, type TaskRow } from "../lib/tasks-store";
import Overview from "./Overview";

const authFetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "t", weddingId: "wed_1", title: "T", notes: null, timeframeBucket: "6m",
  dueAt: null, status: "open", sortOrder: 0, createdAt: 1, completedAt: null, ...over,
});

beforeEach(() => {
  __resetTasksCache();
  authFetch.mockClear();
});

describe("Overview checklist widget", () => {
  it("shows the live open-task count once tasks are cached", async () => {
    setCachedTasks("wed_1", [row({ id: "a", status: "open" }), row({ id: "b", status: "done" })]);
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);
    // "1" open task surfaces on the Checklist card.
    expect(await screen.findByText(/1 open task/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/organiser test -- Overview.checklist`
Expected: FAIL — the card still reads "Coming soon".

- [ ] **Step 3: Widen the `onNavigate` prop type**

In `Overview.tsx`, change the `onNavigate` prop (line ~90) to accept `checklist`:

```typescript
  onNavigate: (
    module: "guests" | "schedule" | "checklist" | "invite" | "settings",
    sub?: string,
  ) => void;
```

- [ ] **Step 4: Add the tasks import + fetch-lift**

Add to the imports (beside the guests/events-store imports, line ~5):

```typescript
import { ensureTasksLoaded, openTaskCount, type TaskRow } from "../lib/tasks-store";
```

Inside the component's load flow (the `Promise.all([...])` around lines 98–112 that already lifts settings/rsvps/events/guests), add a tasks fetch so the count is warm:

```typescript
        ensureTasksLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks`));
          if (res.status === 401) {
            redirectToLogin();
            return [];
          }
          if (!res.ok) throw new Error(`tasks ${res.status}`);
          return ((await res.json()) as { tasks: TaskRow[] }).tasks;
        }),
```

- [ ] **Step 5: Replace the Checklist "coming soon" card**

Replace the Checklist `SnapshotComingSoon` block (lines ~375–380) with a live snapshot. The count is `openTaskCount(props.weddingId)` — `null` while loading (show a neutral label), a number once loaded:

```tsx
            {/* ── Checklist snapshot (Phase 1 — live open-task count) ─────── */}
            <button
              type="button"
              onClick={() => props.onNavigate("checklist")}
              class="border-border bg-surface/15 hover:border-gold/40 flex flex-col gap-2 rounded-sm border p-5 text-left transition-colors"
            >
              <p class="font-body text-gold-dim text-[0.7rem] tracking-[0.18em] uppercase">
                Checklist
              </p>
              <Show
                when={openTaskCount(props.weddingId) !== null}
                fallback={<p class="text-text-muted text-[0.82rem]">Loading your tasks…</p>}
              >
                <Show
                  when={(openTaskCount(props.weddingId) ?? 0) > 0}
                  fallback={<p class="text-text-muted text-[0.82rem]">No tasks yet — add your first.</p>}
                >
                  <p class="text-text text-[0.95rem]">
                    <span class="text-gold text-[1.3rem] font-semibold">
                      {openTaskCount(props.weddingId)}
                    </span>{" "}
                    open {openTaskCount(props.weddingId) === 1 ? "task" : "tasks"}
                  </p>
                </Show>
              </Show>
            </button>
```

(If `Show` is not already imported in `Overview.tsx`, add it to the `solid-js` import.)

- [ ] **Step 6: Run the test — verify it PASSES**

Run: `bun run --cwd cire/organiser test -- Overview.checklist`
Expected: PASS.

- [ ] **Step 7: Run the full organiser suite + type-check**

Run: `bun run --cwd cire/organiser test`
Run: `bun run check`
Expected: PASS — no regressions, `Module` union total everywhere.

- [ ] **Step 8: Commit**

```bash
git add cire/organiser/src/components/Overview.tsx cire/organiser/src/components/Overview.checklist.test.tsx
git commit -m "feat(cire/organiser): live open-tasks Overview widget"
```

---

### Task 9: Changeset + docs

**Files:**
- Create: `.changeset/cire-checklist-tasks.md`
- Modify: `cire/wiki/todo/platform.md` (mark the Checklist module done / in-flight)
- Create: `cire/wiki/systems/checklist-tasks.md` (new-system wiki page)

**Interfaces:** none (docs/metadata only).

- [ ] **Step 1: Write the empty changeset**

Create `.changeset/cire-checklist-tasks.md` (all `@cire/*` are version-less/ignored → an **empty** changeset with NO package lines, so Changeset Check passes without mixing ignored + versioned packages):

```markdown
---
---

Phase 1 Checklist / Tasks module: a freeform per-wedding checklist. Organisers add
tasks, file each under a lead-time bucket (12 months out → day-of) with an optional
due date, check them off, and reorder within a bucket. New `tasks` table
(migration 0038, additive), a `/api/organiser/weddings/:weddingId/tasks` CRUD
router (member reads / editor writes), a `ChecklistView` module in the organiser
IA, and a live "open tasks" count on the Overview.
```

- [ ] **Step 2: Verify the changeset passes the validator**

Run: `bash scripts/validate-changesets.sh` (from repo root)
Expected: PASS — no "mixed ignored + versioned" or "unknown package" error.

- [ ] **Step 3: Update the platform TODO shard**

In `cire/wiki/todo/platform.md`, tick the Phase 1 Checklist/tasks line (mark it shipped) and bump the shard's `last-reviewed` frontmatter to `2026-07-16`. Match the existing checklist bullet style in that file.

- [ ] **Step 4: Write the wiki system page**

Create `cire/wiki/systems/checklist-tasks.md` with the required frontmatter (`title`, `tags`, `related`, `last-reviewed: 2026-07-16`) documenting: the `tasks` table shape, the bucket single-source (server `lib/checklist-buckets.ts` + organiser mirror), the route surface + gates, the store fetch-lift, and the deferred items (template, category, assignee, vendor, Schedule sync, skipped status). Link `[[platform-plan]]`.

- [ ] **Step 5: Final full check**

Run: `bun run --cwd cire/api test && bun run --cwd cire/organiser test && bun run check && bun run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add .changeset/cire-checklist-tasks.md cire/wiki/todo/platform.md cire/wiki/systems/checklist-tasks.md
git commit -m "docs(cire): checklist module changeset + wiki + TODO"
```

- [ ] **Step 7: Push + open the PR (do NOT merge — needs user authorization for the 0038 prod migration)**

```bash
git push -u origin feat/checklist-tasks
gh pr create --title "feat(cire): Phase 1 Checklist / Tasks module" --body "…"
```

The PR body should note: migration 0038 is additive (new empty table); merging auto-applies it to prod D1; requesting explicit authorization to merge.

---

## Self-Review

- **Spec coverage:** data model → Task 1; bucket single-source + optional due date + status enum → Tasks 1/2; API CRUD + reorder + gates + tenancy → Tasks 3/4; ChecklistView (grouping, add/check/edit/delete/reorder, viewer read-only) → Task 6; sidebar promotion + module wiring → Task 7; tasks-store → Task 5; Overview widget → Task 8; testing (service/route/lockstep/component) → Tasks 1,3,4,5,6,7,8; slicing/changeset → Task 9. All spec sections mapped.
- **Deferred items** (template, category, assignee, vendor, Schedule sync, skipped status, cross-bucket drag) are honored — none implemented; noted in the wiki page (Task 9).
- **Type consistency:** `TaskDto` (API, ms-epoch numbers) ↔ `TaskRow` (store, ms-epoch numbers) share field names + JSON shape; `timeframeBucket` string keys identical across server `lib/checklist-buckets.ts` and organiser mirror; `tasksService` method names match their route call-sites; `TaskNotInWedding` tag caught in the route. `move`/`reorder` both key on `orderedIds` array-index → `sortOrder`.
- **Edit not create:** Tasks 4, 7, 8 modify existing files (`app.ts`, `dashboard-route.ts`, `ModuleSidebar.tsx`, `ModuleShell.tsx`, `Overview.tsx`) — exact insertion points given.
- **No placeholders** — every code step carries full code. The only prose-described artifacts are the wiki page (Task 9 §4) and PR body, which are documentation, not code.
