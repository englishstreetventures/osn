---
"@osn/api": patch
"@osn/client": patch
"@osn/social": patch
"@pulse/api": patch
"@pulse/web": patch
"@shared/crypto": patch
"@shared/email": patch
"@shared/observability": patch
"@shared/redis": patch
---

Clear every `anti-slop/no-known-value-widening` hit in application source and
raise the rule from `warn` to `error`. The rule fires when a value the compiler
already knows the shape of — an object literal, an arrow function, a `new` —
is annotated with something broad enough to throw that knowledge away:
`unknown`, `object`, an inline type literal, or any `Record<K, V>`.

Nearly all 116 hits were lookup tables annotated `Record<string, T>`. They split
two ways, and the split is the whole substance of this change:

**Closed-key tables** now carry a trailing `satisfies Record<ClosedUnion, T>`
instead of a leading annotation. The table keeps its literal type, so a missing
key is a compile error rather than a silent `undefined` at the read site — the
opposite of what the `Record` annotation gave.

**Genuinely open-key tables** — the ones read with a runtime string and a `??`
fallback — now declare a named `interface` with an index signature. This states
the real contract (any key may miss) where `Record<string, T>` claimed every key
is present. It also avoids the alternative the first pass reached for, a
`key as keyof typeof TABLE` assertion, which is unsound and would have added to
the `require-safety-comment-for-type-assertion` backlog.

Two of these were latent bugs. `selectAuthRateLimiters` assembled its bundle in
a `Record<string, RateLimiterBackend>` and cast the result to
`AuthRateLimiters`, so a missing limiter slot typechecked; it now builds into a
mapped type with the `readonly` stripped and returns without a cast. `Icon`'s
glyph table was annotated `Record<string, () => JSX.Element>`, which let a new
`IconName` be added to the union with no glyph behind it; the `satisfies` now
forces coverage while `name` stays a plain `string`, since an unrecognised name
rendering nothing is the documented behaviour its tests assert.

Return-type hits were handled by naming the shape. `satisfies` does not silence
those — the rule unwraps it — so `initObservability` and friends now return an
exported interface instead of an inline type literal.

Test files still hold 62 hits, nearly all a fixture table or a stub response
annotated `Record<string, …>` so the test can index it with a computed key, so
the rule stays off in the test override.
