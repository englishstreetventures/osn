---
"@cire/api": minor
"@cire/host": minor
"@cire/db": minor
"@cire/build-tools": minor
---

Push a seat change to every open organiser tab. cire-api binds the
`@shared/realtime` hub (`REALTIME_HUB`, exported from the new Worker entry
`src/entry.ts`), answers `GET /realtime/:topic` before the Elysia app, and
publishes `members-changed` on `cire:wedding:<id>` after a seat is added,
re-roled, removed or left. A member who was removed, left, or lost the
dashboard is revoked: their sockets close with 1008 and their tab stops
listening. The subscribe route limits each client address and each organiser
per minute, and each organiser to 300 subscribes a UTC day, counted in the new
`realtime_subscribe_budget` table (migration 0085). The host portal listens on
the open wedding, re-reads the wedding list on a signal, so a removed or
narrowed member's idle tab drops the wedding's rows within seconds, and has an
open co-host panel read the seats again from the same socket. The portal's CSP
allows the `wss:` API origin, which the shared build integration retargets per
tier. The portal reports a push fallback, and why, to a new rate-limited
`POST /api/realtime/fallback` beacon. The beacon and the CSP report collector
read their bodies bounded as they arrive. With no hub bound, everything behaves
as before.
