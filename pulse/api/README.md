# @pulse/api

Pulse events HTTP server. Bun/Elysia process that listens on **port 3001**
(configurable via `PORT`) and serves `/events` and `/events/:id/rsvp`
routes backed by `@pulse/db`.

## Platform limits

A single source of truth for caps lives in `src/lib/limits.ts`. The
notable one:

| Limit             | Value | Where it bites |
|-------------------|-------|----------------|
| `MAX_EVENT_GUESTS` | 1000  | `POST /events/:id/invite` batch size; visibility-filter graph membership sets in `services/graphBridge.ts`. |

**Why 1000?** Pulse is designed for social events — house parties,
meetups, dinners, community gatherings. 1000 comfortably covers
virtually every personal use case and most small-to-medium community
events (conferences, weddings, festivals).

Beyond 1000, the guest-list visibility filter starts to have meaningful
cost at request time, and the event starts looking more like a ticketed
production than a social gathering. Those events will be served by a
**verified-organisation tier** with bespoke infrastructure (dashboards,
SLA, bulk import/export, paid ticketing — all deferred to Pulse phase 2).

**Raising the cap.** A single-user organiser cannot raise this. When
verified-organisation support lands, accounts with the `org_verified`
claim will be able to **request** bespoke raises on a per-event basis
via a support flow. Until then, 1000 is the platform-wide hard cap.

If you're about to bump `MAX_EVENT_GUESTS`, talk to the team first — it
affects rate limits, DB planning, and the free-vs-paid tier boundary.

## Eden treaty client

The package's `exports` field publishes `@pulse/api/client`, a thin
wrapper around `@elysiajs/eden`'s `treaty<App>()`. Frontends (notably
`@pulse/app`) import that subpath to get fully-typed API calls:

```ts
import { createClient } from "@pulse/api/client";
const api = createClient("http://localhost:3001");
await api.events.get();
```

## Run

```bash
bun run --cwd pulse/api dev
```

## Consumed by

`@pulse/app` (frontend only — `@pulse/api` does not import from any
other workspace except `@pulse/db`).
