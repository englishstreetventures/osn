---
"@cire/api": minor
"@cire/host": minor
"@cire/db": minor
"@cire/build-tools": minor
---

Push a seat change to every open organiser tab. cire-api binds the
`@shared/realtime` hub as `REALTIME_HUB` (the `TopicHub` class is exported from
the new Worker entry `src/entry.ts`), answers `GET /realtime/:topic` before the
Elysia app, and publishes `members-changed` on `cire:wedding:<id>` after a seat
is added, re-roled, removed or left, and after the wedding is deleted. A member
who was removed, left, or lost the dashboard, and every member of a deleted
wedding, is revoked: their sockets close with 1008 and their tab stops
listening. The subscribe route limits each client address (from the portal's
origin) and each organiser per minute, and each organiser to 300 subscribes a
UTC day, counted in the new `realtime_subscribe_budget` table (migration 0092),
which the daily cron also clears of earlier days. The host portal listens on the
open wedding, re-reads the wedding list on a signal, so a removed or narrowed
member's idle tab drops the wedding's rows within seconds, and has an open
co-host panel read the seats again from the same socket. The portal's CSP allows
the `wss:` API origin, which the shared build integration retargets per tier.
The portal reports a push fallback, and why, to a new rate-limited
`POST /api/realtime/fallback` beacon. The beacon and the CSP report collector
read their bodies bounded as they arrive. With no hub bound, `/realtime/*`
answers 503, publishes send nothing, and every other route behaves as before.
