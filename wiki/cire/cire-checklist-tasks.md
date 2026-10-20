---
title: Cire checklist / tasks
tags: [systems, platform, phase1, tasks, cire]
related:
  - "[[index]]"
  - "[[cire-platform-plan]]"
  - "[[cire-host-portal-layout]]"
  - "[[drag-and-drop]]"
  - "[[cire-entitlements]]"
  - "[[d1-limits]]"
last-reviewed: 2026-10-20
---
# Checklist / Tasks

Phase 1 planning module ([[cire-platform-plan]] §4.1). Organisers maintain a
freeform per-wedding task list, file each task under a lead-time **bucket**
(12 months out → day-of), optionally set a due date, check tasks off, and
reorder tasks within a bucket. A couple can also seed the list from the
**starter checklist**, whose due dates follow the wedding date
([[#Starter checklist]]).

## `tasks` table

Created by `0038_tasks.sql`; `0085_task_templates.sql` added the four
template columns and the unique index (`ALTER TABLE ADD`, no rebuild).

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `tsk_<uuid>`, minted by the service |
| `wedding_id` | `text` NOT NULL | FK → `weddings(id)` ON DELETE CASCADE |
| `title` | `text` NOT NULL | |
| `notes` | `text` | nullable |
| `timeframe_bucket` | `text` NOT NULL | one of the eight bucket keys (see below) |
| `due_at` | `text` | nullable ISO-date string; optional, independent of the bucket |
| `status` | `text` NOT NULL | `'open'` (default) or `'done'` |
| `sort_order` | `integer` NOT NULL | default 0; controls display order within a bucket |
| `created_at` | `integer` NOT NULL | unix seconds; the API answers ms-epoch |
| `completed_at` | `integer` | nullable unix seconds; set when `status` flips to `'done'`, cleared on reopen |
| `template_id` | `text` | the template that seeded the task (`'starter'`); NULL on a task the couple typed |
| `template_item` | `text` | the item's stable key in that template; NULL on a typed task |
| `due_offset_days` | `integer` | days from the wedding date the item was seeded with, negative before the day; NULL on a typed task |
| `due_source` | `text` NOT NULL | `'template'`: `due_at` follows the wedding date. `'manual'` (default, and every typed task): `due_at` is whatever the couple set |

**Indexes:**

- `tasks_wedding_bucket_sort_idx ON tasks (wedding_id, timeframe_bucket, sort_order)` — serves the list read (filtered + ordered) without a full scan.
- `tasks_wedding_template_item_unique ON tasks (wedding_id, template_id, template_item) WHERE template_id IS NOT NULL`, unique and partial — one task per template item per wedding, so a repeated or racing apply adds nothing. A typed task has no template and no entry in it.

## Bucket single-source

TWO sibling files define the eight lead-time buckets. Keep them in sync by hand
whenever you add a bucket or reword a label:

| File | Package |
|---|---|
| `cire/api/src/lib/checklist-buckets.ts` | `@cire/api` (server SST) |
| `cire/host/src/lib/checklist-buckets.ts` | `@cire/host` (client mirror) |

The organiser cannot import `@cire/api`, so the label array is duplicated.
Both export the same `TIMEFRAME_BUCKETS` const, `TimeframeBucket` type, and
`TIMEFRAME_BUCKET_KEYS` helper.

Bucket display order (furthest-out first):

| Key | Label |
|---|---|
| `12m` | 12+ months out |
| `9m` | 9 months out |
| `6m` | 6 months out |
| `3m` | 3 months out |
| `1m` | 1 month out |
| `2w` | 2 weeks out |
| `week_of` | Week of |
| `day_of` | Day of |

## Route surface

All routes live under `/api/organiser/weddings/:weddingId/tasks` and are split
into two Elysia factories to avoid gate cross-contamination (the same
read/write split pattern used by the hosts routes in `app.ts`):

| Method | Path | Gate | Factory |
|---|---|---|---|
| `GET` | `/tasks` | `weddingMember` (any role incl. viewer) | `createTaskReadRoutes` |
| `POST` | `/tasks` | `weddingEditor` (owner or editor co-host) | `createTaskWriteRoutes` |
| `PATCH` | `/tasks/reorder` | `weddingEditor` | `createTaskWriteRoutes` |
| `PATCH` | `/tasks/:taskId` | `weddingEditor` | `createTaskWriteRoutes` |
| `DELETE` | `/tasks/:taskId` | `weddingEditor` | `createTaskWriteRoutes` |
| `GET` | `/tasks/templates/:templateId` | `weddingEditor` | `createTaskWriteRoutes` |
| `POST` | `/tasks/templates/:templateId` | `weddingEditor` | `createTaskWriteRoutes` |

The template preview is a read, but it sits behind the write gate: it shows
what applying would add, which only someone who may apply has a use for.

**Gold only, reads included.** Both factories mount `weddingTier(db, "gold")`
directly behind their role gate, so a wedding below Gold gets
`402 { "error": "payment_required", "tier": "gold" }` from every route above and
its tasks stay where they are until it is back on Gold; the owner can still
download them (below). In the portal the Checklist row is locked below
Gold, and Overview neither reads `/tasks` nor shows the Checklist card: a refused
tasks read there would blank the whole snapshot. See [[cire-entitlements]].

**Export (`tasks.csv`).** `GET /api/organiser/weddings/:weddingId/tasks.csv`
hands the owner every task as a spreadsheet **at any tier**: it sits in the
owner-only, per-user-limited export group beside `gifts.csv`, with no tier gate
(see [[cire-entitlements]]). `planningExportService.tasksCsv`
(`cire/api/src/services/planning-export.ts`) prints Timeframe (the bucket's
label), Task, Status (`Open` or `Done`), Due, Completed At and Notes, in the
checklist's order: bucket furthest out first, then `sortOrder`. The stored
bucket keys sort as text in a different order, so the read orders by each
bucket's display position (`displayRank` in `cire/api/src/lib/display-rank.ts`)
and stops in D1 one row past the ceiling. Every cell goes through `serialiseCsv`, and the file stops
at `MAX_PLANNING_EXPORT_ROWS` (1,000) rows with a logged warning. The locked
Checklist card offers it when `GET …/module-rows` counts any tasks.

`/tasks/reorder` is registered **before** `/tasks/:taskId` in the factory so the
literal path wins over the param route — the ordering invariant Elysia
requires.

The `reorder` endpoint accepts `{ timeframeBucket, orderedIds: string[] }` and
writes `sort_order = array-index` for each id in the supplied order. The
service re-scopes every write by `wedding_id`, so a cross-tenant `taskId`
produces a `TaskNotInWedding` tagged error → 404 `task_not_found` at the route
layer.

Viewers (403 `read_only_role`) can read tasks but cannot create, update, or
delete them.

In the portal each bucket is its own sortable list (`ChecklistView.tsx`): a
grip to drag or to move with the arrow keys, plus move-up and move-down buttons
for screen readers, from `@shared/sortable` through `ReorderControls.tsx`. The
move is announced in that bucket's live region and focus stays on the moved
task. A task never moves between buckets by dragging — that would change when
it is due, not its order. See [[drag-and-drop]].

## Starter checklist

A short, neutral list of planning tasks a couple can seed their checklist from,
each due a fixed number of days before the wedding date. Seeded tasks are
ordinary tasks: the couple can tick, reorder, edit or delete any of them.

### Content: one file

`cire/api/src/lib/checklist-starter.ts` holds every item (`key`, `bucket`,
`title`) and one offset per bucket: 12 months out is 365 days before the
wedding date, 9 months 270, 6 months 180, 3 months 90, 1 month 30, 2 weeks 14,
week of 7, day of 0. `cire/api/src/lib/checklist-templates.ts` registers it as
the template `starter`.

- No item assumes a kind of ceremony, a faith or a family role. A couple
  deletes what does not apply, so a short neutral list beats a long specific one.
- A `key` is the item's identity for good. A seeded task stores it, so a
  renamed key would offer the item again to every wedding that already has it.
- A `title` is copied into the task at apply time; rewording one changes only
  weddings that apply the starter afterwards.

`cire/api/tests/lib/checklist-templates.test.ts` fails on a duplicate or
malformed key, an empty title or one over the 200-character task title limit,
an offset after the wedding, and offsets that do not come closer to the wedding
bucket by bucket.

### Preview and apply

| Route | Body | Answer |
|---|---|---|
| `GET …/tasks/templates/:templateId` | — | `{ preview: { templateId, weddingDate, items } }`; each item `{ key, title, timeframeBucket, dueAt, state }` |
| `POST …/tasks/templates/:templateId` | `{ items: string[] }`, the keys the couple ticked | `{ added, tasks }`, the whole checklist after the apply |

An unknown template answers 404 `template_not_found`; a key the template does
not have, or more than 100 keys, 400.

`state` is `new` (not on the checklist), `added` (on it) or `removed` (the
couple deleted it). `dueAt` is null while the wedding has no date: nothing is
guessed, and the portal asks for the date instead. The preview is one SELECT
from `weddings` with two `json_group_array` subqueries. Each binds the wedding
id rather than reading `weddings.id`, because drizzle writes a column in a
selected `sql` field without its table, and inside a subquery over `tasks` a
bare `id` is the task's.

The apply is one batch with no read before it
(`cire/api/src/services/task-templates.ts`):

1. Delete the removal records of the picked keys. Picking an item the couple
   removed is their confirmation to bring it back; the portal never pre-ticks one.
2. `INSERT INTO tasks SELECT … FROM json_each(?) WHERE true ON CONFLICT DO
   NOTHING` (SQLite needs the `WHERE` there, or it reads `ON` as a join
   constraint). The picked items ride as one bound JSON array, so
   the statement binds the same handful of parameters whatever the template's
   length ([[d1-limits]]). The unique index skips an item already there. Each
   task's `due_at` is computed in SQL from the stored wedding date, and its
   `sort_order` puts it after the tasks already in its bucket: SQLite runs the
   whole SELECT before inserting a row when it reads the table it inserts into.
3. Read the checklist back.

`added` is the INSERT's change count, and the counter
`cire.tasks.template.applied` (unit `{task}`, attribute `template`) adds it.

### Removing a seeded task

`DELETE …/tasks/:taskId` writes a `task_template_dismissals` row for a seeded
task and deletes it, in one batch, so a seeded task is never gone without the
record. A typed task records nothing.

| Column | Type | Notes |
|---|---|---|
| `wedding_id` | `text` NOT NULL | FK → `weddings(id)` ON DELETE CASCADE |
| `template_id` | `text` NOT NULL | |
| `template_item` | `text` NOT NULL | |
| `dismissed_at` | `integer` NOT NULL | unix seconds |

Primary key `(wedding_id, template_id, template_item)`.

### Due dates that follow the wedding date

`anchoredDueAt` (`cire/api/src/services/tasks.ts`) is the one expression:
`date(<stored wedding_date>, <offset> || ' days')`, NULL when the wedding has no
date. The preview computes the same date in JS (`addDays`), and
`tests/routes/task-templates.test.ts` holds the two equal across a leap day.

| Event | What happens to `due_at` |
|---|---|
| Apply | The wedding date moved by the item's offset; NULL without a date |
| A settings save that carries `weddingDate` | Every open task with `due_source = 'template'` whose date differs from the stored date's is re-dated, in the same batch as the date write; one already right is not written, so a save that does not move the date writes no task row. A done task keeps its date, a date the couple set is never touched, a refused save moves nothing, and clearing the date clears these due dates |
| The couple sends a `dueAt` | The task's `due_source` becomes `'manual'`, unless the date sent is the one already there (an edit form sends it back with every change) |
| Reopening (`status: "open"` with no `dueAt`) | A seeded task done before the date moved catches up with the current date |

Settings has no tier gate, so a date change re-dates the tasks of a wedding
below Gold too; they are correct when it comes back to Gold.

### In the portal

`ChecklistStarter.tsx`, rendered by `ChecklistView` for an owner or editor: a
card on an empty checklist, a quiet "Starter checklist" button otherwise. The
dialog lists the items not on the checklist by bucket, each with its due date,
and ticks every one whose date is still ahead (or that has none yet). An item
whose date has passed starts unticked and says so, so a late start does not
fill the Overview with overdue tasks; the removed items start unticked under
"You removed these earlier". Without a wedding date an owner is asked to add it
in Settings, and an editor is told an owner can. Each opening starts with
nothing ticked until its preview arrives, so a pick from an earlier opening is
never sent. After an apply the answer's list goes into the cache through
`setFreshTasks`, which drops any list read already in flight. Every close —
Escape and the backdrop included, even mid-apply — clears the dialog's open
state; an apply that fails after the dialog closed says so in a toast.
`SettingsPanel` marks the cache stale after a save that moved the wedding date.

The portal has no due-date editor, so a couple cannot yet move a seeded task's
date by hand there: englishstreetventures/osn#1590.

## Tasks store (organiser client)

`cire/host/src/lib/tasks-store.ts` is a `weddingId`-keyed SolidJS signal
cache — the sibling of `guests-store.ts` and `events-store.ts`. The fetch-lift
pattern means a module switch does not refetch: both the **Overview widget**
(`openTaskCount`) and the **ChecklistView** read from the same signal. This file
deliberately does NOT import Effect (frontend code only).

Public API:

| Export | Purpose |
|---|---|
| `tasksAccessor(weddingId)` | Reactive `Accessor<TaskRow[] \| null>` |
| `hasCachedTasks(weddingId)` | Boolean: are the cached tasks fresh? `false` both before the first load and while the wedding is marked stale (see [[cire-host-portal-layout#Organiser client caches: stale-while-revalidate]]) — it is the refetch trigger, not a render gate |
| `setCachedTasks(weddingId, tasks)` | Populate/replace cache from a fetch. Does not clear the stale mark |
| `setFreshTasks(weddingId, tasks)` | Replace the cache with the whole list a write answered with: drops a load in flight, bumps the generation and clears the stale mark, so no second read follows |
| `peekCachedTasks(weddingId)` | Snapshot read; subscribes only once the entry exists — never track it, use `tasksAccessor` |
| `invalidateTasks(weddingId)` | Mark stale after a write. The rows stay on screen and the signal is untouched — the next `ensureTasksLoaded` is what refetches |
| `ensureTasksLoaded(weddingId, fetcher)` | Fetch if not fresh; dedupes concurrent callers. On success, writes the rows and clears the stale mark; on a refused/failed refetch, blanks the signal and rethrows |
| `openTaskCount(weddingId)` | `number \| null` — open-task count for the Overview widget |
| `taskCounts(weddingId)` | `{ open, done, total } \| null` — reactive counts for the Overview completion bar |

`TaskRow` mirrors `TaskDto` from the API (ms-epoch numbers for `createdAt` /
`completedAt`; `timeframeBucket` string key; `status: "open" | "done"`). The
DTO's provenance fields (`templateId`, `templateItem`, `dueSource`) are left
out of it: nothing in the portal reads them.

## Deferred items

The spec notes these items. v1 deliberately leaves them out; add them
additively:

| Item | Notes |
|---|---|
| Due-date editor | Change a task's due date from the portal (englishstreetventures/osn#1590) |
| Category taxonomy | Closed enum (e.g. venue / catering / flowers / admin); filter UI |
| Assignee | Co-host / organiser assignment per task |
| Vendor linkage | `tasks.vendor_id` → `vendors` (Phase 2); booking a vendor ticks matching tasks |
| Day-of → Schedule sync | Day-of tasks reference a `schedule_event_id`; surface in a run-sheet view |
| `skipped` status | Third status alongside `open`/`done` for tasks that don't apply |
| Cross-bucket drag | Moving a task between buckets (currently reorder is within-bucket only) |

## Hardening

- **Tenancy (reorder)** — `tasksService.reorder` scopes every `UPDATE` by
  `(wedding_id, bucket)`, so foreign or wrong-bucket ids are a no-op write. A
  regression test (`tasks.test.ts` — "reorder is wedding-scoped") proves an
  owner of wedding B cannot shuffle wedding A's checklist. Complements the
  existing update/delete tenancy tests.
- **Tenancy (templates)** — every statement of the preview, the apply and the
  re-dating is scoped by the wedding id, and
  `tests/routes/task-templates.test.ts` proves a date change on one wedding
  leaves another wedding's seeded tasks where they were.
- **`TIMEFRAME_BUCKET_KEYS`** is annotated `readonly TimeframeBucket[]` — a
  consumer cannot mutate the single source of truth for bucket keys.
