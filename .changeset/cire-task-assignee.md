---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

A checklist task can be held by any number of people seated on the wedding —
owners, editors, viewers or helpers — or by nobody. An owner or editor puts a
seat on a task, or takes one off, one seat at a time, so two people changing
different seats at once never undo each other.

`PUT` and `DELETE /api/organiser/weddings/:weddingId/tasks/:taskId/assignees/:hostId`
sit behind the checklist's editor and Gold gates and answer `{ task }`. Both are
idempotent: a seat already on the task, or not on it, answers 200 with the task
as it is. A seat of another wedding, a guest id or an id that names nothing is
422 `assignee_not_in_wedding` on `PUT`, checked inside the write; a task of
another wedding is 404 `task_not_found`. Every task the API returns carries
`assigneeHostIds`, the holders' seat ids in the order they were added, and
`GET /tasks` also answers `viewerHostId`, the caller's own seat. `GET /hosts`
names each seat by its id (`hostId`) and gives its OSN profile photo as
`avatarUrl`, only ever an https URL. Removing a co-host or leaving the wedding
takes them off their tasks and keeps the tasks with their other holders.

In the organiser portal each checklist row shows who holds the task as an
overlapping stack of faces — the reader first, then the order they were added,
three faces and a "+N" count — with each person's OSN photo, or a default empty
avatar when they have none or it will not load. An owner or editor gets a dotted
+ on top of the stack that opens a popover of everyone on the wedding: clicking
a person puts them on the task or takes them off at once, and the popover stays
open until a click outside it, Escape or Tab. Above five people it opens on a
search over names and handles. A viewer sees the faces, and an empty dotted
circle on an open task nobody holds. The task drawer, its Edit button and the
"Needs an owner" mark are gone.

Migration `0087_task_assignees.sql` adds the `task_assignees` table — one row
per task and seat, with `assigned_at` — whose two foreign keys,
`(task_id, wedding_id)` to `tasks` and `(host_id, wedding_id)` to
`wedding_hosts`, both cascade on delete and refuse a task paired with another
wedding's seat. It adds the unique indexes on `tasks(id, wedding_id)` and
`wedding_hosts(id, wedding_id)` those keys reference.
