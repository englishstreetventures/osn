---
"@cire/api": patch
---

Migrate `@cire/api`'s Effect Schema surface to v4 — the last package on v3.
**The whole monorepo now type-checks and passes its tests under Effect v4.**

Everything phase 4 established applies here too (checks via `.check(...)`,
`makeFilter` carrying its own message, `Literals([…])`, `decodeUnknownEffect`),
plus four things cire hit first:

- **`Schema.Union` takes one array**, not variadic members. Silent when it slips
  through — a two-member union read as a single member, and the inference
  degrades to `{}` rather than erroring at the call.
- **`Schema.optionalWith(S, { default: () => v })` becomes
  `S.pipe(Schema.withDecodingDefaultType(Effect.succeed(v)))`** — 22 sites, all
  the same shape.
- **A decode failure is tagged `SchemaError`, not `ParseError`.** Upstream's
  generated reference leaves `ParseResult.ParseError` as "TODO: needs
  guidance"; the compiler answers it. 41 `catchTag`/`catchTags` sites and one
  type annotation in `services/changes.ts`.
- **`Cause` is a list of reasons**, so `cause._tag === "Fail" && cause.error
  instanceof X` becomes `Option.getOrUndefined(Cause.findErrorOption(cause))
  instanceof X`. That still refuses a defect, exactly as the `Fail` check did.

`Schema.transform` → `Schema.decodeTo(target, SchemaTransformation.transform(…))`
was needed only twice (the time-zone canonicaliser and the URL normaliser) and
once for a clamp. Three "trim, then bound the length" pairs collapse to
`Schema.Trim.check(isMinLength(1), isMaxLength(n))` — verified to trim before
checking, so `"   "` is still rejected as blank. v4 short-circuits a `.check(…)`
list on the first failure, so `TimeZone`'s length cap still runs before the ICU
lookup it exists to protect.

Two test fixes are consequences of phase 3's logger rework rather than of
Schema. `cire/api`'s unhandled-error log test isolated its line by
`startsWith('{"')`; the local renderer is indented now, so that filter caught a
fragment. `Logger.layer` also replaces the whole active set, so there is no
default logger left emitting the stack dump the filter existed to exclude — the
whole capture is that one entry, which makes the "no raw SQLite message" check
strictly stronger. Also drops five `Logger` imports left dead by phase 3.
