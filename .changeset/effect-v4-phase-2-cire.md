---
"@cire/api": patch
---

Apply the Effect v4 combinator renames.

`catchAllDefect` → `catchDefect`, `catchAll` → `catch`, `either` → `result`,
`zipRight` → `andThen`, `dieMessage` → `die(new Error(…))`, `Layer.scoped` →
`Layer.effect`. Schema-decode tests that assert on a `Result` tag move from
`"Right"`/`"Left"` to `"Success"`/`"Failure"`; the one test file decoding
through `Schema.decodeUnknownEither` is left for the Schema phase, since that
becomes an `Exit` rather than a `Result`.

Second phase of the Effect v4 migration; the tree does not type-check until the
`Schema` work lands.
