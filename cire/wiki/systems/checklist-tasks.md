---
title: "Checklist / Tasks — Phase 1 planning module"
tags: [systems, platform, phase1, tasks]
related:
  - "[[index]]"
  - "[[platform-plan]]"
  - "[[platform]]"
last-reviewed: 2026-07-23
---

# Checklist / Tasks

Phase 1 planning module ([[platform-plan]] §4.1). Organisers maintain a
freeform per-wedding task list, file each task under a lead-time **bucket**
(12 months out → day-of), optionally set a due date, check tasks off, and
reorder tasks within a bucket.

## `tasks` table

Migration `0038_tasks.sql` (additive — new table only, no existing table
touched):

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | cuid2 minted by the service |
| `wedding_id` | `text` NOT NULL | FK → `weddings(id)` ON DELETE CASCADE |
| `title` | `text` NOT NULL | |
| `notes` | `text` | nullable |
| `timeframe_bucket` | `text` NOT NULL | one of the eight bucket keys (see below) |
| `due_at` | `text` | nullable ISO-date string; optional, independent of the bucket |
| `status` | `text` NOT NULL | `'open'` (default) or `'done'` |
| `sort_order` | `integer` NOT NULL | default 0; controls display order within a bucket |
| `created_at` | `integer` NOT NULL | ms-epoch |
| `completed_at` | `integer` | nullable ms-epoch; set when `status` flips to `'done'`, cleared on reopen |

**Index:** `tasks_wedding_bucket_sort_idx ON tasks (wedding_id, timeframe_bucket, sort_order)` — serves the list read (filtered + ordered) without a full scan.

## Bucket single-source

TWO sibling files define the eight lead-time buckets. Keep them in sync by hand
whenever you add a bucket or reword a label:

| File | Package |
|---|---|
| `cire/api/src/lib/checklist-buckets.ts` | `@cire/api` (server SST) |
| `cire/organiser/src/lib/checklist-buckets.ts` | `@cire/organiser` (client mirror) |

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

## Tasks store (organiser client)

`cire/organiser/src/lib/tasks-store.ts` is a `weddingId`-keyed SolidJS signal
cache — the sibling of `guests-store.ts` and `events-store.ts`. The fetch-lift
pattern means a module switch does not refetch: both the **Overview widget**
(`openTaskCount`) and the **ChecklistView** read from the same signal. This file
deliberately does NOT import Effect (frontend code only).

Public API:

| Export | Purpose |
|---|---|
| `tasksAccessor(weddingId)` | Reactive `Accessor<TaskRow[] \| null>` |
| `hasCachedTasks(weddingId)` | Boolean: first load done? |
| `setCachedTasks(weddingId, tasks)` | Populate/replace cache from a fetch |
| `peekCachedTasks(weddingId)` | Non-reactive snapshot |
| `invalidateTasks(weddingId)` | Evict after a write |
| `openTaskCount(weddingId)` | `number \| null` — open-task count for the Overview widget |

`TaskRow` mirrors `TaskDto` from the API (ms-epoch numbers for `createdAt` /
`completedAt`; `timeframeBucket` string key; `status: "open" | "done"`).

## Deferred items

The spec notes these items. v1 deliberately leaves them out; add them
additively:

| Item | Notes |
|---|---|
| Seeded template | Generate starter tasks from `wedding_date` (from Settings); re-anchor incomplete seeded tasks on date change |
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
- **`TIMEFRAME_BUCKET_KEYS`** is annotated `readonly TimeframeBucket[]` — a
  consumer cannot mutate the single source of truth for bucket keys.
