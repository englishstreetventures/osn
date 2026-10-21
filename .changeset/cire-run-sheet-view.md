---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@tools/e2e": patch
---

The day-of run sheet. A checklist task can be given a time on the day: a fixed
time in a zone, or a link to an event counted in minutes from its start, which
follows the event wherever it moves (migration `20261021153838_task_run_time`,
`PATCH …/tasks/:taskId` `runTime`; every task answer carries the derived time).
`GET …/run-sheet` lists the wedding's events, each with its run of show, with
every timed or day-of task, by instant, narrowed on the server to a helper's
scope, Gold and 120 a minute per organiser. A schedule change lists the tasks
linked to an event it removes, removes the ones the organiser chose and keeps
the rest unlinked at their time; an apply or revert that touches events, a
change to a run of show alone included, tells the open tabs. In the portal: a
Gold "Run sheet" module showing each event's run of show inside its band in the
order guests read it, a helper's seat that opens onto the run sheet in its own
cache scope, "Helper (needs Gold)" below Gold, the change preview's choice, and
the checklist's and the run sheet's caches built on one shared re-read factory.
The end-to-end suite reads the run sheet as an owner and as a helper scoped to
their own tasks, and moves and removes its events.
