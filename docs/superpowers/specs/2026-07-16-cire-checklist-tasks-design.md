# Cire Phase 1: Checklist / Tasks module — design

Date: 2026-07-16
Branch: `feat/checklist-tasks`
Scope: `cire/db`, `cire/api`, `cire/organiser` (all `@cire/*` — version-less, empty changeset)

## Goal

First Phase 1 module: a **freeform wedding checklist**. Organisers add tasks,
organise them by lead-time bucket (12 months out → day-of), check them off, and
see an "open tasks" count on the Overview. v1 is a plain task manager — no seeded
template, no category taxonomy, no vendor/assignee linkage. Those layer on later.

## Settled design decisions (the brainstorm)

Three choices locked with the user:

1. **Freeform first** — no seeded checklist template in v1. The organiser fills
   their own tasks. A versioned template resolved against `wedding_date` is a
   later addition, not this slice.
2. **Timeframe buckets** — tasks organise into lead-time columns. The organiser
   assigns the bucket; buckets are not auto-derived.
3. **Manual bucket + optional date** — the organiser picks the bucket from a
   dropdown. `due_at` is a **separate optional** field with no dependency on
   `wedding_date`. A task can sit in a bucket with or without a due date.

## Data model — migration `0038_tasks.sql` (new `tasks` table)

```
tasks
  id                text PK              -- app-minted id (same idiom as events/families)
  wedding_id        text NOT NULL       -- FK → weddings(id) ON DELETE CASCADE
  title             text NOT NULL
  notes             text                 -- nullable
  timeframe_bucket  text NOT NULL        -- enum, see below
  due_at            text                 -- nullable ISO date (YYYY-MM-DD), independent of bucket
  status            text NOT NULL DEFAULT 'open'   -- 'open' | 'done'
  sort_order        integer NOT NULL DEFAULT 0     -- order within a bucket
  created_at        integer NOT NULL     -- ms epoch, Drizzle timestamp mode
  completed_at      integer              -- nullable ms epoch; set when status → done
```

Index: `CREATE INDEX tasks_wedding_bucket_sort ON tasks(wedding_id, timeframe_bucket, sort_order)`
— serves the one grouped read (all tasks for a wedding, ordered within bucket).

**`timeframe_bucket` enum** (ordered, bounded cardinality):
`'12m' | '9m' | '6m' | '3m' | '1m' | '2w' | 'week_of' | 'day_of'`.
Ordered keys + display labels live in **one shared const**
(`cire/api/src/lib/checklist-buckets.ts`), the single source for validation
(server) and column order + labels (client mirrors the labels). Same
single-source pattern the service-category enum will use.

**Deferred (kept out of v1):** `category` (service-category enum), `assignee`
(osn profile), `vendor_id` (Phase 2 FK), day-of → Schedule linkage, `'skipped'`
status. All are additive later; none reshapes the v1 table.

**DDL discipline:** all three surfaces move in lockstep — the numbered migration,
`cire/api/src/db/setup.ts` DDL, and `cire/api/src/db/schema.ts` Drizzle table.
The `ddl-lockstep.test.ts` (T-S1) invariant must stay green at 0038. Migration is
additive (pure `CREATE TABLE` + `CREATE INDEX`) — no rebuild, no prod data risk.
Merging auto-applies it to prod D1 via `deploy.yml` (`d1 migrations apply --remote`);
being a new empty table, it needs no columns-empty confirmation, but the merge
still needs explicit per-change user authorization (auto-mode migration guardrail).

## API — `/api/organiser/weddings/:weddingId/tasks`

Per-row CRUD. Tasks sit **outside** the guest/schedule desired-state reconcile
pipeline (like organiser-recorded RSVPs) — a plain service, not `changes/*`.
Every write re-validates wedding-scoped tenancy (the task's `wedding_id` must
match the `:weddingId` in the path; cross-tenant → 404).

| Method + path | Body | Gate |
|---|---|---|
| `GET    /tasks` | — | `weddingMember()` |
| `POST   /tasks` | `{ title, timeframeBucket, dueAt?, notes? }` | `weddingEditor()` |
| `PATCH  /tasks/:taskId` | `{ title?, timeframeBucket?, dueAt?, notes?, status?, sortOrder? }` | `weddingEditor()` |
| `DELETE /tasks/:taskId` | — | `weddingEditor()` |
| `PATCH  /tasks/reorder` | `{ timeframeBucket, orderedIds: string[] }` | `weddingEditor()` |

- `GET` returns a **flat** list (client groups by bucket) ordered by
  `(timeframe_bucket, sort_order)`. Any member role reads.
- `POST` validates `timeframeBucket` against the shared enum (reject unknown →
  400). New task appends to the end of its bucket (`sort_order` = current max + 1).
- `PATCH` on `status`: `'done'` stamps `completed_at = now`; `'open'` clears it
  back to `NULL`. Bucket change is a plain field update (task keeps its
  `sort_order`; acceptable minor imperfection in v1).
- `reorder` sets `sort_order` for each id in `orderedIds` to its array index,
  scoped to the given bucket + wedding, in one D1 batch. Ids not under the
  wedding/bucket are ignored (defensive).

New surface, so it mounts directly under a `/tasks/*` prefix — this is effectively
the first real module-router. No alias forwarding needed (nothing pre-existing to
redirect). The broader reprefix of existing routes stays deferred.

Service `cire/api/src/services/tasks.ts`, routes `cire/api/src/routes/tasks.ts`,
mirroring the organiser-rsvp service/route split.

## Frontend — `cire/organiser`

- **`ChecklistView.tsx`** — the module screen. Renders buckets in lead-time order
  (labels from the shared const, mirrored client-side). Each bucket is a section
  listing its tasks. Interactions: add task (title + bucket dropdown + optional
  due date + optional notes), inline check-off (toggle `status`), edit, delete,
  drag-reorder **within** a bucket (calls `reorder`). Empty buckets render a
  subtle add prompt rather than hiding. **Viewer role is read-only** — no add/
  edit/complete/reorder controls (mirrors existing per-view viewer gating).
- **Sidebar promotion** — Checklist is an Overview "coming soon" card today.
  Promote it to a real sidebar rail module (`ModuleSidebar` + `dashboard-route`).
- **`lib/tasks-store.ts`** — weddingId-keyed cache, sibling of `guests-store` /
  `events-store`, with fetch-lift so tab navigation doesn't refetch.
- **Overview widget** — replace the Checklist "coming soon" card with a live
  **"N open tasks"** widget reading from `tasks-store`. Honest empty state:
  "No tasks yet" when zero (no fabricated numbers).

Prefer an existing small drag-reorder primitive over hand-rolling if one is
already in the organiser deps; otherwise a minimal HTML5 drag handler is fine for
within-bucket reorder.

## Testing

- **Service** (`tasks.test.ts`): create/list/patch/delete; tenancy isolation
  (wedding A cannot read or mutate wedding B's task); `status → done` sets and
  `→ open` clears `completed_at`; reorder rewrites `sort_order` in order; reject
  unknown `timeframe_bucket`.
- **Route** (`tasks.route.test.ts`): authz matrix — viewer 403 `read_only_role`
  on writes but 200 on `GET`; guest/non-member rejected; editor writes; member
  reads; cross-tenant task id → 404.
- **DDL/lockstep**: T-S1 green with `tasks` at migration 0038 across all three
  surfaces.
- **Component**: bucket grouping + order; add/edit/complete/reorder happy paths;
  viewer read-only (no controls rendered); Overview open-tasks widget count +
  empty state.

## Slicing + changeset

One cohesive PR: schema + API + organiser UI + Overview widget. Fresh table, no
dependency on other in-flight schema work, so no need to split. All touched
packages are `@cire/*` (version-less) → **empty changeset** (`changeset add --empty`),
never mixed with `@osn/api`.

## Out of scope (explicit)

Seeded/versioned template · category taxonomy · assignee · vendor linkage ·
day-of → Schedule sync · `skipped` status · cross-bucket drag ordering · task
comments/attachments · reminders/notifications. Each is a clean later addition.
