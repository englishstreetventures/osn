---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

An owner or editor can hand any checklist task to someone seated on the
wedding — an owner, editor, viewer or helper — from a task drawer opened by
the row's Edit button. Every row names who holds its task, and every open task
nobody holds says "Needs an owner", for a viewer too.

`PUT /api/organiser/weddings/:weddingId/tasks/:taskId/assignee` takes
`{ assignedHostId: string | null }` behind the checklist's editor and Gold
gates. A seat of another wedding, a guest id or an id that names nothing is
422 `assignee_not_in_wedding`, checked inside the write. The task list now
carries `assignedHostId`, and `GET /hosts` names each seat by its id
(`hostId`). Removing a co-host or leaving the wedding clears their assignments
and keeps the tasks.

Migration `0087_task_assigned_host.sql` adds `tasks.assigned_host_id`, a
reference to `wedding_hosts(id)` with ON DELETE SET NULL, and a partial index
on it.
