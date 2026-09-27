---
"@cire/api": minor
"@cire/host": minor
---

Push a co-host change to every open organiser tab. cire-api binds the
`@shared/realtime` hub (`REALTIME_HUB`, exported from the new Worker entry
`src/entry.ts`), answers `GET /realtime/:topic` before the Elysia app, and
publishes `members-changed` on `cire:wedding:<id>` after a co-host is added,
re-roled or removed — closing the affected co-host's sockets so their access is
checked again. The host portal listens on the open wedding and re-reads the
wedding list on a signal, so a removed or narrowed co-host's idle tab drops the
wedding's rows within seconds. The portal's CSP now allows the `wss:` origin.
The portal reports a push fallback, and why, to a new rate-limited
`POST /api/realtime/fallback` beacon. With no hub bound, everything behaves as
before.
