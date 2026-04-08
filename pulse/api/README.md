# @pulse/api

Pulse events HTTP server. Bun/Elysia process that listens on **port 3001**
(configurable via `PORT`) and serves `/events` and `/events/:id/rsvp`
routes backed by `@pulse/db`.

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
