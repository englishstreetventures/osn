---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
"@cire/landing": patch
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
`avatarUrl`, only ever an https URL on musubi's identity host (the origin of
`OSN_ISSUER_URL`) with no user name or password, at most 2,048 characters; any
other photo URL osn-api sends is dropped. Removing a co-host or leaving the wedding
takes them off their tasks and keeps the tasks with their other holders.

In the organiser portal each checklist row shows who holds the task as an
overlapping stack of faces — the reader first, then the order they were added,
three faces and a "+N" count — with each person's OSN photo, or a default empty
avatar when they have none or it will not load. An owner or editor gets a dotted
+ on top of the stack, over the count's edge as over a face's; before the + the
count is always a pill, its figures 7px clear of the +'s ring, so "+2" or "+12"
always reads whole. A viewer's count is a disc until its figures need more room. The + opens a popover of everyone on the wedding: clicking
a person puts them on the task or takes them off at once, and the popover stays
open until a click outside it, Escape or Tab. Above five people it opens on a
search over names and handles. The person Enter will toggle is marked by a bar
in the focus ring's colour and gold ink on their name, and a polite status line
under the list says it is finding the people, how many a search matches, or
that it matches nobody. Photos load with no `Referer`. A viewer sees the faces, and an empty dotted
circle on an open task nobody holds. The task drawer, its Edit button and the
"Needs an owner" mark are gone.

Migration `0091_task_assignees.sql` adds the `task_assignees` table — one row
per task and seat, with `assigned_at` — whose two foreign keys,
`(task_id, wedding_id)` to `tasks` and `(host_id, wedding_id)` to
`wedding_hosts`, both cascade on delete and refuse a task paired with another
wedding's seat. It adds the unique indexes on `tasks(id, wedding_id)` and
`wedding_hosts(id, wedding_id)` those keys reference, and indexes
`task_assignees` on `(wedding_id, task_id, assigned_at)` and
`(host_id, wedding_id)`, so a task's holders and both cascades find their rows
without walking the wedding's. It then copies each task's single assignee from
`0087_task_assigned_host.sql` onto the table, when that seat is of the task's
own wedding. `tasks.assigned_host_id` stays in the database, unread, so the API
version before this one keeps working while a deploy migrates and if it rolls
back, though holders changed while that version serves are lost when this one
returns, so roll forward rather than leave it serving. The Drizzle schema no
longer declares the column, and the first cire-api release after this one
reaches production drops it (englishstreetventures/osn#1636).

Release order: the organiser portal reads both task shapes — `assigneeHostIds`,
or the single `assignedHostId` the API before this one sends, shown as the
task's one holder — so `@cire/host` can ship first, and should: the portal
before this one reads no holders from this API, and its assign drawer writes a
route this API no longer has.

The hosts' privacy notice on the marketing site now says that everyone on a
wedding sees the others' musubi name, handle and profile photo, and which
checklist tasks each holds.
