---
"@osn/api": minor
"@osn/client": minor
"@osn/db": minor
"@pulse/api": minor
"@pulse/db": minor
"@zap/api": minor
"@zap/db": minor
"@shared/crypto": minor
"@shared/db-utils": minor
"@shared/email": minor
"@shared/observability": minor
"@shared/redis": minor
---

Move every Effect dependency to 4.0.0-rc.112 and convert the service keys.

`effect`, `@effect/vitest` and `@effect/opentelemetry` are pinned to one exact
version, because v4 releases the ecosystem under a single version number and is
still pre-GA — a caret range would let an install move the target mid-migration.
`@effect/platform` is dropped: v4 merged it into core, and nothing here imported
it.

`Context.Tag` no longer exists. Class declarations become
`Context.Service<Self, Shape>()(id)` — note the argument order flips — and the
`Context.Tag<any, A>` parameter types in `@shared/db-utils` become
`Context.Key<any, A>`. Every service identifier string is unchanged, since those
are the runtime lookup keys. Call sites are untouched: a v4 service key still
extends `Effect`, so `yield* Db` works as before.

This is the first phase of the Effect v4 migration and does not stand alone —
the tree does not type-check until the `Schema` work lands.
