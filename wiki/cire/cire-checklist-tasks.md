---
title: Cire checklist / tasks
tags: [systems, platform, phase1, tasks, cire]
related:
  - "[[index]]"
  - "[[cire-platform-plan]]"
  - "[[cire-host-portal-layout]]"
  - "[[drag-and-drop]]"
  - "[[cire-entitlements]]"
  - "[[cire-auth]]"
  - "[[d1-limits]]"
last-reviewed: 2026-10-20
---
# Checklist / Tasks

Phase 1 planning module ([[cire-platform-plan]] §4.1). Organisers maintain a
freeform per-wedding task list, file each task under a lead-time **bucket**
(12 months out → day-of), optionally set a due date, check tasks off, and
reorder tasks within a bucket. A couple can also seed the list from the
**starter checklist**, whose due dates follow the wedding date
([[#Starter checklist]]), and hand any task to as many people seated on the
wedding as they like ([[#Assignees]]).

## `tasks` table

Built by the baseline `0001_initial.sql` (`migrations-archive/0038_tasks.sql`
first); `0086_task_templates.sql` added the four template columns and the
unique index with `ALTER TABLE ADD` and no rebuild, and
`0087_task_assignees.sql` the unique index on `(id, wedding_id)` that the
holders table references ([[#Assignees]]).

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

Who holds a task is not a column here: it is the `task_assignees` table
([[#Assignees]]).

**Indexes:**

- `tasks_wedding_bucket_sort_idx ON tasks (wedding_id, timeframe_bucket, sort_order)` — serves the list read (filtered + ordered) without a full scan.
- `tasks_wedding_template_item_unique ON tasks (wedding_id, template_id, template_item) WHERE template_id IS NOT NULL`, unique and partial — one task per template item per wedding, so a repeated or racing apply adds nothing. A typed task has no template and no entry in it.
- `tasks_id_wedding_unique ON tasks (id, wedding_id)`, unique — the parent key of `task_assignees`' task foreign key. `id` alone is already unique; the pair is what lets a holder row name the task's wedding as well.

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
| `PUT` | `/tasks/:taskId/assignees/:hostId` | `weddingEditor` | `createTaskWriteRoutes` |
| `DELETE` | `/tasks/:taskId/assignees/:hostId` | `weddingEditor` | `createTaskWriteRoutes` |
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

## Assignees

A task can be held by any number of seats of its wedding — owners', editors',
viewers' or helpers' — or by none. A holder is a seat (`wedding_hosts.id`), not
a profile id, because the helper run sheet filters on the seat
(`runSheetVisibleTo`, [[cire-auth#The run-sheet scope]]).

### `task_assignees` table

Built by `0087_task_assignees.sql`: one row per task and seat.

| Column | Type | Notes |
|---|---|---|
| `task_id` | `text` NOT NULL | the task |
| `host_id` | `text` NOT NULL | the seat holding it |
| `wedding_id` | `text` NOT NULL | the wedding of both |
| `assigned_at` | `integer` NOT NULL | unix seconds, when the seat was put on the task |

Primary key `(task_id, host_id)`, so a seat holds a task once. Two composite
foreign keys, both ON DELETE CASCADE:

| Columns | References |
|---|---|
| `(task_id, wedding_id)` | `tasks(id, wedding_id)` — unique index `tasks_id_wedding_unique` |
| `(host_id, wedding_id)` | `wedding_hosts(id, wedding_id)` — unique index `wedding_hosts_id_wedding_unique` |

`wedding_id` rides in both, so the database refuses a row that pairs a task with
a seat of another wedding, whichever wedding the row names. The service never
sends one (below); the keys are what make "every holder of a task is a seat of
its wedding" true of the table rather than of the code that writes it.

**Indexes.** Each leads with exactly the equalities of the reads it serves.
D1 keeps no planner statistics ([[d1-limits]]), and without them SQLite costs
an equality on any index's first column the same, so an index led by
`wedding_id` alone wins every tie and walks the whole wedding's assignments to
find one task's or one seat's.

| Index | Serves |
|---|---|
| `task_assignees_wedding_task_idx (wedding_id, task_id, assigned_at)` | one task's holders, read by every holder write and every task edit; the task cascade's probe `(task_id, wedding_id)`; the checklist read of the whole wedding, task by task, with no sort |
| `task_assignees_host_wedding_idx (host_id, wedding_id)` | the seat cascade's probe, on every seat removed or co-host leaving |

[`tests/db/task-assignees-index.test.ts`](../../cire/api/tests/db/task-assignees-index.test.ts)
pins the four plans with `EXPLAIN QUERY PLAN`.

**Order.** A task's holders read back by `assigned_at`, then `rowid`.
`assigned_at` is in seconds, so two seats added in the same second would tie;
rowid keeps them in the order they were added. A seat taken off and put back
goes to the end. The checklist read orders by `task_id` first, the index's
order; each task's holders keep the same order within it.

### Routes

| Route | What it does | Answer |
|---|---|---|
| `PUT …/tasks/:taskId/assignees/:hostId` | puts the seat on the task | `{ task }` |
| `DELETE …/tasks/:taskId/assignees/:hostId` | takes the seat off the task | `{ task }` |

Neither takes a body; anything sent is ignored. Both sit in the write group, so
an owner or editor on Gold may call them; a viewer gets 403 `read_only_role`, a
helper 403 `forbidden`, a wedding below Gold 402, and the origin guard covers
both.

A write names one seat, so two people changing different seats of the same task
at once never undo each other — a route that replaced the whole list would drop
a pick a colleague made in between. Both are idempotent: putting on a seat the
task already holds, or taking off one it does not, answers 200 with the task as
it is.

| Case | `PUT` | `DELETE` |
|---|---|---|
| A seat id over 64 characters (Effect Schema, `AssigneeHostId` in `cire/api/src/schemas/tasks.ts`) | 400 `Missing or invalid fields` | 400 |
| An empty seat id | matches no route: 404 | 404 |
| A task that is not this wedding's | 404 `task_not_found` | 404 `task_not_found` |
| A seat that is not this wedding's — another wedding's seat, a guest id, a task id, an id that names nothing | **422 `assignee_not_in_wedding`**, nothing written | 200, unchanged |
| The seat already on the task / not on it | 200, unchanged | 200, unchanged |
| The database fails the write | 500 `Internal error`, nothing written | 500, nothing written |

`tasksService.addAssignee` and `removeAssignee` (`cire/api/src/services/tasks.ts`)
each send one batch of three statements:

1. The write. `INSERT INTO task_assignees SELECT … FROM tasks WHERE id = ? AND
   wedding_id = ? AND EXISTS (a wedding_hosts row with that id and this
   wedding's id) ON CONFLICT DO NOTHING RETURNING host_id` — the task row
   supplies its own id and wedding — or `DELETE … WHERE task_id = ? AND host_id
   = ? AND wedding_id = ? RETURNING host_id`.
2. The task, scoped to the wedding.
3. Its holders, in order.

No task is `TaskNotInWedding`. When the INSERT wrote nothing, the holders tell
the other two answers apart: a seat among them was already there; a seat not
among them is not one of the wedding's — the foreign keys make every holder of a
task a seat of its wedding — and is `HostNotInWedding`. The seat check rides in
the write, so a refusal is a 422, never a foreign-key 500, and a seat removed
while a PUT runs is either not found or taken off again by the cascade.

**Every task the API returns carries `assigneeHostIds`**, the holders' seat ids
in that order: `GET /tasks` reads every holder of the wedding in the same batch
as its tasks, two statements however long the checklist; `PATCH /tasks/:taskId`
reads the task's holders in the batch with its UPDATE, so ticking a task done
keeps them; the starter apply reads them with the checklist it answers with; a
task just created has none. No route but the two above writes a holder:
`assigneeHostIds` sent to `POST` or `PATCH` is ignored.

`GET /tasks` also answers `viewerHostId`, the caller's own seat id, which
`weddingMember()` reads in the query that admits them, so the portal can tell
which holder is the reader without a second request.

**A seat that goes takes only its own holds.** Removing a co-host or leaving the
wedding (`hostsService.remove`) deletes the seat, and the cascade deletes its
rows; the tasks stay, with their other holders. A refused last-owner leave
deletes nothing. Deleting a task deletes its rows, and a wedding purge reaches
them through both keys.

`GET …/hosts` names each seat by its id (`hostId`), what `assigneeHostIds`
name, and gives its OSN photo as `avatarUrl` when the profile has an https one
on musubi's identity host ([[cire-auth]]).

The counter `cire.tasks.assignment.changed` (unit `{request}`) counts every
write by `action` (`add`, `remove`) and `result` (`ok`, `unchanged`,
`task_not_found`, `assignee_not_in_wedding`, `error`). The spans are
`cire.tasks.assign` and `cire.tasks.unassign`. A write the database fails is
counted as `error` and logged as `checklist holder write failed`, with the
wedding id and the action, before the route answers 500.

### In the portal

Each row of `ChecklistView.tsx` shows who holds the task as an overlapping stack
of faces (`TaskHolders.tsx`): the reader's own seat first when they hold it, then
everyone in the order they were put on it — three faces, then a "+N" bubble for
the rest. A face is the person's OSN photo, or the empty avatar — a person's
outline in the page's colour on a disc of faint ink, never initials — when they
have none or it will not load (`PersonAvatar.tsx`; the portal's CSP admits no
avatar host until englishstreetventures/osn#1207, so today every photo fails and
falls back). The faces are pictures only: the row says "Held by Sam Lee and @jo"
in screen-reader text for every role, and each face shows its name on hover.

| Who | Task held | Open, nobody | Done, nobody |
|---|---|---|---|
| Owner, editor | the stack, with a dotted circle holding a + as its top-right layer; the whole stack is one button, "Assign people to *title*" | the + alone | the + alone |
| Viewer | the stack | an empty dotted circle, "Nobody assigned yet" (`role="img"`) | nothing |

The reader's seat is `viewerHostId` from `GET /tasks`; `readTaskList` in
`tasks-store.ts` keeps it beside the rows, and both readers of the list — the
checklist and Overview — go through it. The seats come from `lib/hosts-store.ts`,
a cache with the contract in [[cire-host-portal-layout#Organiser client caches: stale-while-revalidate]];
the checklist reads it only once some task is held, or when an owner or editor
opens a popover. Until the seats answer, the stack shows an empty avatar per
holder and says "Held by 2 people". A seat the loaded list no longer has has
gone — the server took it off its tasks — and is left off the stack.

The button opens a Kobalte popover: a listbox of everyone on the wedding,
`aria-multiselectable`, the reader first ("You · Owner"), then the order
`GET /hosts` lists them. Each row is a toggle circle — an outline when the person
does not hold the task, filled with a tick when they do — their face, their
name and their role. Clicking a row puts them on the task or takes them off at
once, and the popover stays open until a click outside it, Escape or Tab, the
last two giving the focus back to the button. Above five people a search over
names and handles heads the list, which shows about four rows and scrolls; five
or fewer show whole with no search. The focus starts in the search when there
is one, else on the list; the arrows, Home and End move the highlight, and
Enter toggles it — Space too on the list, but not in the search, where it types
the space a name has. The rows stay usable while writes are out; the list says
`aria-busy` instead.

The rows are keyed by task id behind a memo that ignores `assigneeHostIds` as it
ignores `sortOrder` (`sameButOrder` in `lib/sortable-rows.ts`, with the field
named), and the stack reads the live task by id. A change of who holds a task
therefore keeps its row, its button and an open popover.

The writes (`lib/holder-writes.ts`) go one at a time **per task and seat**, so
two people's toggles go at once and cannot undo each other. A pick shows at
once: it is laid over the cached holders rather than written into them, so the
cache keeps what the server last said, a refused pick goes back by dropping it
— seat by seat — and a re-read of the tasks cannot wipe a pick still out. A pick
made while its seat's write is out waits; when the write answers, the seat's
latest pick is written if the cache does not already agree with it. An answer is
taken into the cache whole when its write flew alone; one that flew beside
another write of the same task may have been read before the other was stored,
so only its own seat is taken from it. A refusal of a pick the organiser still
wants says so in a toast and reads the tasks again; a 422 also reads the seats
again, whether or not the pick still stands. A 401 or an expired session sends
the organiser to sign in, and nothing more is sent.

The first opening of a popover on a visit to the checklist reads the seats from
the server unless the visit has read them already; later openings use that read.
While they load the popover says it is finding the people; a read that fails
says so inside it, until seats arrive or the next read starts.
The co-host panel hands the checklist the seats it reads on opening, photos
included, and marks them stale after each add, role change and removal. A
removal marks the tasks stale too when a cached task names the removed seat
among its holders, or when the seat was added on this visit and the panel never
saw its id.

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
`setFreshTasks`, so a list read already in flight is discarded. Every close —
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
| `setFreshTasks(weddingId, tasks)` | Replace the cache with the whole list a write answered with: bumps the generation (a load in flight discards what it fetches) and clears the stale mark, so no second read follows. Writes nothing for a closed wedding |
| `peekCachedTasks(weddingId)` | Snapshot read; subscribes only once the entry exists — never track it, use `tasksAccessor` |
| `invalidateTasks(weddingId)` | Mark stale after a write. The rows stay on screen and the signal is untouched — the next `ensureTasksLoaded` is what refetches |
| `ensureTasksLoaded(weddingId, fetcher)` | Fetch if not fresh; dedupes concurrent callers. On success, writes the rows and clears the stale mark; on a refused/failed refetch, blanks the signal and rethrows |
| `openTaskCount(weddingId)` | `number \| null` — open-task count for the Overview widget |
| `taskCounts(weddingId)` | `{ open, done, total } \| null` — reactive counts for the Overview completion bar |
| `readTaskList(weddingId, list)` | Take a `GET /tasks` answer apart: keeps its `viewerHostId` for the wedding and returns the rows for the loader. Keeps nothing for a closed wedding |
| `viewerHostIdOf(weddingId)` | `string \| null` — the reader's own seat, as the last task read named it; reactive |

`TaskRow` mirrors `TaskDto` from the API (ms-epoch numbers for `createdAt` /
`completedAt`; `timeframeBucket` string key; `status: "open" | "done"`;
`assigneeHostIds`, the holders' seat ids in the order they were put on the task,
empty for nobody). The DTO's provenance fields
(`templateId`, `templateItem`, `dueSource`) are left out of it: nothing in the
portal reads them.

## Deferred items

The spec notes these items. v1 deliberately leaves them out; add them
additively:

| Item | Notes |
|---|---|
| Due-date editor | Change a task's due date from the portal (englishstreetventures/osn#1590) |
| Category taxonomy | Closed enum (e.g. venue / catering / flowers / admin); filter UI |
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
- **Tenancy (assignees)** — the holder INSERT reads the task by `(id,
  wedding_id)` and admits only a seat of that same wedding, the DELETE is
  scoped by the wedding, and the composite foreign keys refuse any row that
  pairs a task with another wedding's seat. `tests/routes/tasks.test.ts` ("the
  people holding a task") proves another wedding's seat, a guest id, a task id
  and a stray id are each 422 with nothing written, and that a task of another
  wedding is 404 and untouched; `tests/db/d1-integration.test.ts` runs both
  batches, both foreign keys and both cascades on Miniflare.
- **Tenancy (templates)** — every statement of the preview, the apply and the
  re-dating is scoped by the wedding id, and
  `tests/routes/task-templates.test.ts` proves a date change on one wedding
  leaves another wedding's seeded tasks where they were.
- **`TIMEFRAME_BUCKET_KEYS`** is annotated `readonly TimeframeBucket[]` — a
  consumer cannot mutate the single source of truth for bucket keys.
