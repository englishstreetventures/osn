---
title: Effect v4 API Shapes
aliases:
  - effect v4
  - effect v3 to v4
  - effect renames
tags:
  - architecture
  - effect
  - migration
status: current
related:
  - "[[backend-patterns]]"
  - "[[schema-layers]]"
  - "[[testing-patterns]]"
packages:
  - "@osn/api"
  - "@pulse/api"
  - "@zap/api"
  - "@cire/api"
last-reviewed: 2026-09-08
---

# Effect v4 API Shapes

Every v3 form below will not compile, and the v4 form beside it is what to
write instead. This page exists because the v3 shapes are still what a model
reaches for from memory and what every pre-2026-09 example on the internet
shows — knowing that a rename happened is not enough to write the new name.

The repo moved off Effect v3 on 2026-09-06. Which packages are on it, and why
the pin is exact rather than caret, is in `CLAUDE.md` under Conventions —
kept there rather than repeated here so there is one place for it to be right.

Most of the surface is unchanged. `Effect.gen`, `provide`, `runPromise`,
`tryPromise`, `fail`, `flip`, `withSpan`, `catchTag`, `provideService`,
`annotateLogs`, `Layer.effect`/`succeed`/`merge`, `Option.*`, `Exit.*`,
`it.effect`, `it.layer`, and **`Data.TaggedError`** — this repo's whole error
vocabulary — all needed zero edits.

## Renames

| v3 | v4 |
| --- | --- |
| `Effect.catchAll` / `catchAllDefect` / `catchAllCause` | `Effect.catch` / `catchDefect` / `catchCause` |
| `Effect.either` | `Effect.result` |
| `Effect.zipRight` / `forkDaemon` / `dieMessage` | `Effect.andThen` / `forkDetach` / `die(new Error(…))` |
| `Effect.yieldNow()` | `Effect.yieldNow` — a value, not a call |
| `Layer.scoped` | `Layer.effect` — it supplies and excludes the `Scope` |
| `Either` module | `Result` — tags are `"Success"`/`"Failure"` |
| `Cause.failureOption` | `Cause.findErrorOption` |
| `Context.Tag(id)<Self, Shape>()` | `Context.Service<Self, Shape>()(id)` — argument order flips; `Context.Tag<I, S>` in **type** position is `Context.Key<I, S>` |

Service **identifier strings** are runtime lookup keys. Preserve them exactly
through any such rewrite — a typo is a service-not-found at request time, not a
compile error.

## Errors, `Cause` and `Runtime`

`FiberFailure` is gone. `runPromise` rejects with `Cause.squash(cause)`, which
for a typed failure is the tagged error itself — so a `catch` that checks
`_tag` now matches. The catch: where v3's `Cause.failureOption` returned `None`
for a **defect**, `squash` hands you the defect object, which can carry an
internal message. Gate on the tag before showing a rejection to anyone.

`Cause` is a flat list of reasons, so there is no `Fail` node:

```ts
// v3: exit.cause._tag === "Fail" && exit.cause.error instanceof NotFound
Option.getOrUndefined(Cause.findErrorOption(exit.cause)) instanceof NotFound
```

`ManagedRuntime` no longer extends `Effect`; `runtimeEffect`/`runtime` are
`contextEffect`/`context`, and `Runtime<R>` is replaced by `Context<R>`.

## Schema

`Schema.decodeUnknown` is `decodeUnknownEffect`, and its failure is tagged
**`SchemaError`**, not `ParseError` — that is what `catchTag` takes. Constraint
combinators are *checks*, applied with a schema's `.check(…)`:

```ts
Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 99 }))
Schema.String.check(Schema.isPattern(/^\d{4}$/))
Schema.String.check(Schema.makeFilter((s) => ok(s) ? undefined : "why not"))
```

`isMinLength`/`isMaxLength` cover collections too (v3's `minItems`/`maxItems`).
A `makeFilter` returns `undefined`/`true` for success and **a string as the
failure message**; a check's `message` annotation is a plain string, not a
thunk. `.check(a, b)` short-circuits on the first failure, so ordering a cheap
bound before an expensive lookup still works.

Four more, and the first two fail quietly:

- **`Schema.Literal` takes one literal, `Schema.Union` takes one array.** Pass
  the v3 variadic shape and the extra members are dropped rather than rejected;
  the mistake surfaces later as `{}` where a real type was expected, or as a
  union that has stopped rejecting one of its cases. Use
  `Schema.Literals([…])` and `Schema.Union([…])`.
- **Decode messages no longer echo the input.** v4 renders a reason line plus
  an `at ["path"]` line where v3 wrote `Expected number, actual "x"`. A test
  pinned to the old text passes vacuously if it only checks something threw.
- `Schema.optionalWith(S, { default: () => v })` →
  `S.pipe(Schema.withDecodingDefaultType(Effect.succeed(v)))`.
- `Schema.transform(from, to, {decode, encode})` →
  `from.pipe(Schema.decodeTo(to, SchemaTransformation.transform({ decode, encode })))`.
  Often unnecessary: `Schema.Trim.check(…)` covers "trim then bound", and
  `Schema.DateFromString` now rejects a string that parses to an Invalid Date,
  which is what three hand-rolled transforms here existed for.
  `Schema.parseJson(S)` is `Schema.fromJsonString(S)`; `DateFromSelf` is `Date`;
  `Schema.Record({key, value})` is positional, `Schema.Record(key, value)`.

## Logging

`Logger.layer([…])` **replaces the whole active set**, so
`Logger.tracerLogger` must be listed explicitly or log-to-span correlation
disappears with no error and no failing type-check. Levels are string literals
(`"Warn"`, not v3's `"Warning"`), the minimum level is
`References.MinimumLogLevel` rather than `Logger.withMinimumLogLevel`,
annotations live on the fiber rather than the logger's `Options`, and **the
JSON severity field is `level`, not `logLevel`** — a Grafana query on the old
name matches nothing. `@shared/observability` owns all of this; see
`[[wiki/observability/logging]]`.

## Layer memoization

The `MemoMap` is shared across `Effect.provide` calls **within one run**, not
across separate `runPromise` roots. A per-request `Effect.provide(scopedLayer)`
is a new root every time, so it still **builds and tears the layer down on
every request** — measured, 5 provides → 5 acquires and 5 releases, against a
`ManagedRuntime`'s 1 acquire and 0 releases. So the v3 rebuild-cost argument
for a shared runtime is not weakened at all where it matters; if anything the
"Effect runtime" rule in `CLAUDE.md`'s Conventions table is understated. The
pattern itself is in [[backend-patterns]].

