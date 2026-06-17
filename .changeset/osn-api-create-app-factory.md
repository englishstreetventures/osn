---
"@osn/api": patch
---

Refactor osn/api into a pure `createApp` factory + a Bun dev entry, with no
behaviour change (Phase 1 of the Cloudflare Workers migration).

- `src/app.ts` exports `createApp(deps)` — the Elysia route composition,
  verbatim — taking an explicit `AppDeps` struct (auth config, cookie config,
  CORS origins, origin guard, rate limiters, stores, layers, shared
  `appRuntime`). It never reads `process.env`.
- `src/local.ts` owns all env-driven Bun wiring: `buildAppDeps()` loads the JWT
  key pair, validates the session-IP pepper, initialises Redis-backed stores +
  rate limiters, selects the email transport, and builds the Effect layer graph
  ONCE into a shared `ManagedRuntime`; `startBunServer()` keeps the
  `app.listen`, ephemeral-key warning, outbound ARC key rotation, and the
  account-erasure sweeper.
- `src/index.ts` stays the Bun composition entry tests import: it calls
  `buildAppDeps()` + `createApp()`, still exports `app`, and still conditionally
  listens off `NODE_ENV`.

Redis/ioredis, observability, and the Workers `fetch` entry are untouched —
they belong to later phases.
