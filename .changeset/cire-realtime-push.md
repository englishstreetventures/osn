---
"@cire/api": minor
"@cire/host": minor
"@cire/db": minor
"@cire/build-tools": minor
---

Push seat and checklist changes to every open organiser tab, a helper's
included. cire-api binds the `@shared/realtime` hub as `REALTIME_HUB` (the
`TopicHub` class is exported from the new Worker entry `src/entry.ts`), answers
`GET /realtime/:topic` before the Elysia app for every seat that reads the run
sheet, and publishes on `cire:wedding:<id>`: `members-changed` after a seat is
added, re-roled, removed or left, after a helper's run-sheet scope moves, and
after the wedding is deleted; `tasks-changed` after every checklist write that
changed something — create, edit, tick, untick, delete, a reorder that moved a
task, a starter apply that added a task, a holder put on or taken off, and a
settings save that re-dated a seeded task. The checklist's writes are limited to
120 a minute per organiser. A member who was removed or left, and every member of a
deleted wedding, is revoked: their sockets close with 1008 and their tab stops
listening; a member narrowed to helper keeps listening. The subscribe route
limits each client address (from the portal's origin) and each organiser per
minute, and each organiser to 300 subscribes a UTC day, counted in the new
`realtime_subscribe_budget` table (migration
`20261021141814_realtime_subscribe_budget.sql`), which the daily cron also
clears of earlier days. The host portal listens on the open wedding for every
role: `members-changed` re-reads the wedding list, so a removed or narrowed
member's idle tab drops the wedding's rows within seconds, and has an open
co-host panel read the seats again; `tasks-changed` has the checklist and
Overview read the tasks again, one read for however many signals land while a
read is out. A re-read never undoes the tab's own write, and a re-read a signal
asks for during that write goes once it ends. The portal's CSP allows
the `wss:` API origin, which the shared build integration retargets per tier.
The portal reports a push fallback, and why, to a new rate-limited
`POST /api/realtime/fallback` beacon. The beacon and the CSP report collector
read their bodies bounded as they arrive. With no hub bound, `/realtime/*`
answers 503, publishes send nothing, and every other route behaves as before.
