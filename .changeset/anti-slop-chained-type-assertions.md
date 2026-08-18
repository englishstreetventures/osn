---
"@osn/api": patch
"@osn/ui": patch
"@pulse/web": patch
"@shared/db-utils": patch
"@shared/feature-flags": patch
"@shared/observability": patch
"@shared/osn-auth-client": patch
"@shared/redis": patch
---

Clear every `anti-slop/no-chained-type-assertions` hit in application source and
raise the rule from `warn` to `error`. A double assertion — `x as unknown as T` —
tells the compiler to stop checking, so each of the 32 sites was either a type
that could be stated honestly or a claim that was no longer true.

Most were the second kind. `buildAppDeps` and `selectEmailLayer` now name the
env vars they read instead of taking a loose string record, so the Workers `env`
binding passes structurally with no cast at all. `UpstashLike` mirrors the
`@upstash/redis` mutable array signature and the wrapper copies on the way in.
`FLAGS` is widened once on the way out of the registry, which removes three
casts and a `Widen` round-trip at every call site. `commitBatch` probes for
`.batch()` with a type guard rather than asserting the driver has one.

One was a live bug: `pulse/web`'s create-event form cast a `Date` to `string`
and relied on `JSON.stringify` to serialise it on the way out. It now calls
`toISOString()` where the conversion happens.

Test files still hold 161 hits — mostly a fixture cast to the shape under test —
so the rule stays off in the test override.
