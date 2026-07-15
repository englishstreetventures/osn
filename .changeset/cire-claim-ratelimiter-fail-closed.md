---
"@cire/api": patch
---

Fail-closed when the `CLAIM_RATE_LIMITER` native binding is missing in a deployed tier.

The Worker entry (`cire/api/src/index.ts`) read the native Workers rate-limit
binding for the pre-auth guest claim endpoint and, when absent, **silently fell
back to a per-isolate in-memory limiter**. Because that limiter is per-isolate it
gives almost no real cross-request protection, so a misconfigured/missing binding
silently downgraded the claim-code brute-force defence (small keyspace) with no
signal — the wrangler foot-gun where named envs don't inherit the top-level
`[[unsafe.bindings]]`.

Now the binding is REQUIRED in any deployed tier: when it's absent and the tier
(from `OSN_ENV`, via `@shared/observability` `loadConfig` — the same signal that
drives the log level) is `dev`/`staging`/`production`, the edge handler
`Effect.logError`s and refuses with a 503 on every cold isolate, mirroring the
Turnstile / `weddingMember` fail-closed convention. The `local` tier keeps the
in-memory fallback so `bun run dev` and bun:sqlite tests boot without the binding.
The prod Worker declares the binding under `[env.production.unsafe.bindings]` in
`wrangler.toml`, so the guard only trips on a genuine misconfiguration. Regression
tests cover local→fallback, deployed→503, and binding-present→native.
