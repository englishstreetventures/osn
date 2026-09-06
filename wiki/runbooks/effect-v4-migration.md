---
title: Effect v4 migration
description: How the Effect 3.22 → 4.0 bump gets done here — driven by the official effect-v3-to-v4 skill and upstream's generated rename reference, with the measured local surface and the phase order.
tags: [runbook, effect, tooling, migration, dependencies]
severity: medium
status: in-progress
related:
  - "[[backend-patterns]]"
  - "[[schema-layers]]"
  - "[[testing-patterns]]"
  - "[[observability/overview]]"
  - "[[monorepo-structure]]"
last-reviewed: 2026-09-06
---

# Effect v4 migration

Effect is the functional core of every backend here — `@osn/api`, `@pulse/api`,
`@zap/api`, `@cire/api`, five `@shared/*` packages and four `*/db` packages.
361 files import it; 793 tests run through `it.effect`. Fourteen packages declare
`effect`, eleven declare `@effect/vitest`.

The migration is **driven by the official `effect-v3-to-v4` skill**, not by this
page. The skill and upstream's generated rename reference are the authority on
every API mapping. This page exists for what upstream cannot know: how much of
this repo each change touches, which of our own conventions the bump
invalidates, and the order the phases land in.

> [!important] Read the skill first, not this page's tables
> `.claude/skills/effect-v3-to-v4/SKILL.md` (installed from `Effect-TS/skills`)
> is the procedure. The tables below are a sizing estimate that was checked
> against upstream on 2026-09-06 — useful for planning, **not** a substitute for
> looking each symbol up as you reach it. Where they disagree, upstream wins.

## The official skills

Two skills are installed, from the `Effect-TS/skills` repository:

| Skill | What it is |
| --- | --- |
| `effect-ts` | Points the agent at `node_modules/effect/AGENTS.md` — the guidance the installed Effect version ships with, so it never drifts from the version in the tree |
| `effect-v3-to-v4` | The migration procedure. Not model-invoked; call it explicitly |

Installed with `npx skills add Effect-TS/skills`, which writes
`.agents/skills/<name>/`, symlinks `.claude/skills/<name>` at it, and records
the source and a content hash per skill in `skills-lock.json`. `npx skills
update` moves the pin. Both trees are under a human owner in
`.github/CODEOWNERS`.

### What the skill does

It refuses to guess. Every rename, removal and signature change is resolved
from **upstream's generated reference**, obtained by shallow-cloning the Effect
repo into `.repos/` (gitignored):

```sh
git clone --depth 1 --single-branch https://github.com/Effect-TS/effect .repos/effect
git clone --depth 1 --single-branch --branch v3 https://github.com/Effect-TS/effect .repos/effect-v3
```

- `.repos/effect/MIGRATION.md` — background and the index of topic guides.
- `.repos/effect/migration/v3-to-v4.md` — **the generated reference, ~16,600
  lines.** Never read whole; `rg` it one symbol at a time. Reading it in one
  pass costs ~350k tokens and takes the migration with it.
- `.repos/effect/migration/*.md` — fourteen topic guides for changes that are
  rewrites rather than renames. The ones this repo needs: `services.md`,
  `error-handling.md`, `schema.md`, `runtime.md`, `layer-memoization.md`,
  `scope.md`, `cause.md`, `forking.md`.
- v4 source under `.repos/effect/packages/*/src/`, to confirm a replacement's
  real signature before writing against it.

Lookup recipes, per the skill:

```sh
rg -n 'Effect\.catchAllDefect' .repos/effect/migration/v3-to-v4.md
rg -n -A 40 '^### `effect/Schema`' .repos/effect/migration/v3-to-v4.md
```

Its hard prohibitions, which hold for every phase here:

- **No `v3-compat.ts`.** A shim that re-exports old names makes the type errors
  vanish and freezes the codebase between versions permanently.
- **No `any`, no `as`** to silence a post-migration error. Such an error is
  usually evidence the replacement has a different shape, and a cast deletes
  that information.
- **No invented APIs.** Every replacement traces to the reference, a topic
  guide, or v4 source.

It also delegates per-file work to sub-agents, one file or module each, so the
main session keeps the error inventory rather than the file contents.

### Where we deliberately diverge from the skill

The skill's done condition is **a clean type-check**, and it says explicitly
that running the test suite is recommended but *not* a gate — sensible for a
generic repo mid-migration, where tests often cannot run for unrelated reasons.

**Here, tests and the dev tier are the gate.** That is the decision this
migration rests on: 793 `it.effect` tests plus two D1 tiers plus a full dev-tier
smoke are what stands between a wrong mapping and a live wedding. A type-check
alone does not catch a `Layer` whose finalizer stopped running or a log field
that quietly changed name — both of which are real risks below.

So: use the skill's procedure and its prohibitions verbatim, and treat its
done condition as the *floor*. Every phase in this page names test gates on
top, and phase 7 adds the dev-tier smoke.

## Versions and the ecosystem

As of 2026-09-06, npm `dist-tags` for `effect`: `latest` is `3.22.1`, `beta` is
`4.0.0-beta.107`, `rc` is `4.0.0-rc.112` (published 2026-08-25). Upstream's own
`MIGRATION.md` still opens with *"Effect v4 is currently in beta. APIs may
change between beta releases."*

That is a fact to plan around, not a blocker: the safety net is the test suite
and the dev tier, and the phase order below keeps every step verifiable. **Pin
an exact version rather than a range** while v4 is pre-GA, so a `bun install`
cannot move the target mid-migration.

The soak rule is satisfied either way — `bunfig.toml` sets `minimumReleaseAge
= 259200` (3 days) and rc.112 cleared that on 2026-08-28. **No
`minimumReleaseAgeExcludes` entry, and no `# DROP AFTER` marker, is needed or
wanted.**

| Package | Declared here | v4 | Note |
| --- | --- | --- | --- |
| `effect` | `^3.22.1` (**14** packages) | yes | |
| `@effect/vitest` | `^0.30.0` (**11** packages) | yes | Peer is `vitest >=4.1.0 <5.0.0`; every workspace already declares `^4.1.11` |
| `@effect/opentelemetry` | `^0.64.0` (`shared/observability`) | yes | Stays a separate package, but its modules were renamed — see below |
| `@effect/platform` | `^0.97.1` (`shared/observability`) | **merged into core** | Nothing here imports it. Delete the line |

v4 gives the whole ecosystem **one shared version number**, so `effect`,
`@effect/vitest` and `@effect/opentelemetry` must all sit on the same version.
`@effect/platform`, `@effect/rpc` and `@effect/cluster` merged into core; what
stays separate is platform-, provider- and technology-specific
(`@effect/platform-*`, `@effect/sql-*`, `@effect/ai-*`, `@effect/opentelemetry`,
`@effect/vitest`).

Some functionality now lives under `effect/unstable/*` (http, sql, rpc,
observability, …), which may break in minor releases. Nothing here imports any
of it today.

There is **no codemod**. `@effect/codemod` last published in July 2024 and
covers v2 → v3 only.

## What does not change

Most of the call surface. Verified present in v4: `Effect.gen` (1606 sites),
`Effect.provide` (972), `Effect.runPromise` (461), `Effect.tryPromise` (451),
`Effect.sync` (373), `Effect.fail` (346), `Effect.flip` (325), `Effect.promise`
(294), `Effect.withSpan` (248), `Effect.catchTag` (228), `Effect.provideService`
(182), `Effect.succeed` (142), `Effect.logError` (109), `Effect.tapError` (100),
`Effect.all`, `Effect.runPromiseExit`, `Effect.annotateLogs`,
`Effect.tapDefect`, `Effect.void`, `Effect.try`, `Layer.effect`/`succeed`/
`merge`/`provide`, `Option.*`, `Exit.*`, `it.effect`, `it.layer`.

**`Data.TaggedError` has no entry in the migration reference at all** — it is
unchanged. That is 165 sites and the repo's entire error vocabulary, needing
zero edits, and it is the single most load-bearing piece of good news here.

Two notes on style rather than breakage. v4's shipped `AGENTS.md` prefers
`Effect.fn("name")` over functions that return an `Effect.gen`, and uses
`Schema.TaggedError` in its examples where we use `Data.TaggedError`. Neither is
forced. **Do not fold either into this migration** — a style sweep across 165
error classes buried inside a version bump is unreviewable. File it separately
if it is wanted.

## What changes

Sizes are this repo's, measured at `851df71`. Mappings were checked against
`migration/v3-to-v4.md` on 2026-09-06.

### Renames

| v3 | v4 | Sites | Files |
| --- | --- | ---: | ---: |
| `Effect.catchAll` | `Effect.catch` | 42 | 24 |
| `Effect.catchAllDefect` | `Effect.catchDefect` | 94 | 20 |
| `Effect.catchAllCause` | `Effect.catchCause` | 1 | 1 |
| `Effect.either` | `Effect.result` | 71 | 13 |
| `Effect.forkDaemon` | `Effect.forkDetach` | 7 | 5 |
| `Effect.zipRight` | `Effect.andThen` | 7 | 3 |
| `Effect.dieMessage` | `Effect.die(new Error(…))` | 2 | 2 |
| `Layer.scoped` | `Layer.effect` — scoped acquisition merged in; it supplies and excludes the layer `Scope` | 6 | 4 |
| `Cause.failureOption` | `Cause.findErrorOption` | 4 | 4 |
| `Either` module | `Result` — `isLeft`→`isFailure`, `isRight`→`isSuccess`, `left`→`fail`, `right`→`succeed` | — | 4 |

`Effect.catchAll` → `Effect.catch` needs a word-boundary match, or it also
rewrites `catchAllDefect` and `catchAllCause`. Do those two first.

`Layer.scoped` sites are `shared/redis/src/service.ts`,
`shared/redis/src/ioredis.ts`, `cire/api/tests/services/import.test.ts`,
`cire/api/tests/db/test-layer.ts`. The two `shared/redis` ones manage a real
connection lifecycle, so the finalizer has to survive the rewrite — a
`Layer.effect` that drops the scope leaks Redis connections, and the limiters
fail closed ([[rate-limiting]]), so the symptom is rejected requests rather
than an obvious crash. A type-check will not catch this; the tests must.

### `Context.Tag` → `Context.Service`

13 declarations, 11 files. A structural change, not a symbol swap — read
`migration/services.md`. A v4 service key still extends `Effect`, so **every
`yield* DbService` call site is unaffected**; only the declarations change. That
makes this the highest-leverage phase: small, central, and it unblocks
type-checking for whole packages at once.

| File | Declaration |
| --- | --- |
| `osn/db/src/service.ts:27` | `Db` (`@osn/db/Db`) |
| `pulse/db/src/service.ts:18` | `Db` (`@pulse/db/Db`) |
| `zap/db/src/service.ts:16` | `Db` (`@zap/db/Db`) |
| `cire/api/src/db/index.ts:24` | `DbService` |
| `cire/api/src/services/invite-assets.ts:57` | `AssetsR2Service` |
| `cire/api/src/services/r2-imports.ts:32` | `R2Service` |
| `shared/redis/src/service.ts:21` | `Redis` |
| `shared/email/src/service.ts:45` | `EmailService` |
| `osn/client/src/service.ts:175` | `OsnAuth` |
| `osn/client/src/storage.ts:11` | `Storage` |
| `shared/db-utils/src/index.ts:77,113` | two `Context.Tag<any, …>` **parameter types** |

Do `shared/db-utils` first. Those two are type positions on generic helpers
imported by every service that touches a database, so a wrong signature there
produces errors everywhere and buries the real ones. `Context.Tag.Service<T>`
becomes `Context.Service.Shape<T>`; `Context.TagClass` becomes
`Context.ServiceClass`.

Preserve every identifier string exactly (`"@osn/db/Db"`,
`"@shared/email/EmailService"`, …). They are the runtime lookup keys — a typo is
a service-not-found at request time, not a compile error.

Nothing here uses `Effect.Service`, so `Context.Service` becomes the single
form.

### Runtime and layers — the part CLAUDE.md gets wrong under v4

Two upstream changes land on a documented convention of ours.

**`ManagedRuntime` no longer extends `Effect`.** `runtimeEffect` / `runtime`
became `contextEffect` / `context`, `ManagedRuntime.Context` became
`ManagedRuntime.Services<T>`, and `make` takes `{ memoMap }`. The repo threads
one `ManagedRuntime` through route factories via `makeAppRunner` —
`osn/api/src/lib/route-runtime.ts` (where `AppRuntime` is declared),
`osn/api/src/build-deps.ts:404`, `osn/api/src/app.ts`, plus `safe-error.ts` and
`grant-failure.ts`. Read `migration/runtime.md`; `Runtime<R>` itself is gone
and `Context<R>` replaces it.

**Layer memoization is now global.** In v3 each `Effect.provide` call had its
own memo scope, so two calls with overlapping layers built them twice. In v4 the
`MemoMap` is shared across `Effect.provide` calls unless `{ local: true }`.
Read `migration/layer-memoization.md`.

That second one makes the *stated rationale* in `CLAUDE.md`'s **Effect runtime**
row inaccurate under v4 — it warns that a per-request `Effect.provide` "rebuilds
the layer (restarts the OTel SDK + opens a new DB conn) every call", which
global memoization largely stops. The shared-`ManagedRuntime` pattern is still
right, for boot cost and lifecycle ownership; the reason given for it is not.
**Phase 7 rewrites that row.** Do not quietly start using per-request
`Effect.provide` on the strength of this — the pattern stands, only the
explanation changes.

### Logging

28 sites, 12 files, and the two entries most likely to break something silently.

| v3 | v4 |
| --- | --- |
| `Logger.pretty` | `Logger.layer([Logger.consolePretty(), Logger.tracerLogger])` |
| `Logger.prettyLogger` | `Logger.consolePretty` |
| `Logger.replace` | `Logger.layer([…desiredLoggers])` — v4 replaces the **whole** active set |
| `Logger.jsonLogger` | `Logger.formatJson` |
| `Logger.withMinimumLogLevel` | `Effect.provideService(effect, References.MinimumLogLevel, level)` |
| `Logger.minimumLogLevel` | `Layer.succeed(References.MinimumLogLevel, level)` |
| `LogLevel.Debug` and siblings | The string literals `"Debug"`, `"Info"`, … — v4 levels are literals, not branded objects |

> [!warning] Two silent regressions to watch
> **`Logger.tracerLogger` must be listed explicitly.** `Logger.layer` replaces
> the entire active logger set, so a migration that writes
> `Logger.layer([Logger.consolePretty()])` drops log-to-span correlation with no
> error and no failing type-check. Every log line still appears; it just stops
> being attached to a trace.
>
> **v4's JSON log output uses `level`, not `logLevel`.** Any Grafana query,
> alert or dashboard filtering on `logLevel` silently matches nothing after the
> bump. Inventory those before phase 4 and update them with it.

`shared/observability/src/logger/layer.ts` owns the logger layer for every
service, so its shape decides the rest. The other sites are the three
`src/local.ts` dev entrypoints (`osn/api`, `pulse/api`, `zap/api`),
`zap/api/src/index.ts`, and six test files.

`@effect/opentelemetry` renamed its modules too: `Logger` → `OtelLogger`
(`layerLoggerAdd`/`layerLoggerReplace` collapse into
`OtelLogger.layer({ mergeWithExisting })`), `Metrics` → `OtelMetrics`, `Tracer`
→ `OtelTracer`. `NodeSdk` and `WebSdk` keep their names.

The three rules in [[observability/overview]] still hold — no `console.*`, no
raw OTel constructors, no unbounded metric attributes. `Logger.consolePretty`
is Effect-owned, so it does not violate the first.

**Do not regress the workerd carve-out.** `osn/api/src/observability.ts`
deliberately avoids `@effect/opentelemetry/NodeSdk`'s import graph, which does
not run on workerd. `osn/api/tests/observability.test.ts` asserts this and is
the guard.

### `Schema`

1105 sites, 58 files (49 source, 9 test) — the largest item. Read
`migration/schema.md`. Two thirds is one package:

| Package | Schema files |
| --- | ---: |
| `cire/api` | 38 |
| `pulse/api` | 8 |
| `osn/api` | 5 |
| `zap/api` | 3 |
| `cire/theme` | 3 |
| `osn/client` | 1 |

| v3 | v4 |
| --- | --- |
| `Schema.decodeUnknown` | `Schema.decodeUnknownEffect` — a straight rename |
| `Schema.decodeUnknownEither` | `Schema.decodeUnknownExit` |
| `Schema.maxLength` / `minLength` / `int` / `between` / `pattern` / `maxItems` / `minItems` / `greaterThan*` / `lessThan*` | `Schema.isMaxLength` and siblings, applied with `Schema.check(…)` or a schema's `.check` method |
| `Schema.optionalWith` | `Schema.optional` / `Schema.optionalKey` / `Schema.withDecodingDefaultType`, chosen by which v3 options were passed |
| `Schema.transform` | `schema.pipe(Schema.decodeTo(target, SchemaTransformation.transform({ decode, encode })))` |
| `Schema.DateFromSelf` | `Schema.Date` |
| `Schema.parseJson` | `Schema.UnknownFromJsonString`, or `Schema.fromJsonString(schema)` with an inner schema |

`Schema.Array`, `Struct`, `Record`, `Union`, `Literal` and `Tuple` survive by
name.

**The filter rewrite is where validation can silently loosen.** `maxLength(n)`
→ `check(isMaxLength(n))` is a shape change on every constrained field, and
these schemas guard guest-supplied input on a public site. Diff the effective
constraints; do not eyeball the shape.

> [!warning] `ParseResult.ParseError` has no upstream mapping yet
> The generated reference lists it as **"TODO: needs guidance"**. Our one site
> is `cire/api/src/services/changes.ts` — line 3 imports the module, line 253
> names `ParseResult.ParseError` in the error channel of an **exported**
> signature, so it ripples to callers. Resolve it from v4 source
> (`SchemaIssue` / `SchemaParser` / `ErrorReporter`) and, per the skill, report
> the gap rather than bridging it with a cast. Re-check the reference before
> starting — upstream may have filled it in.

[[schema-layers]] is the rule this must not break: Elysia TypeBox at the HTTP
boundary, Effect Schema in services, never mixed. v4 does not touch TypeBox, so
the boundary is unchanged — but a half-migrated service is exactly where someone
reaches across it to make an error go away.

### Tests

`@effect/vitest`'s `assertFailure` **changed meaning**: in v3 it asserted on an
`Exit`, in v4 it asserts a `Result.Failure`, and the v3 behaviour moved to
`assertExitFailure`. This repo uses neither helper (zero occurrences), so
nothing here is exposed — worth knowing before anyone adds one mid-migration.

## What the phase-0 spike found

Run 2026-09-06 on `shared/crypto`, against `effect@4.0.0-rc.112`, using this
skill. It answered the question it existed to ask, and the answer **changes the
phase plan** — see [[#Phase order]] below, which has been rewritten around it.

### Effect cannot be bumped one package at a time

Bun resolves two Effect majors side by side without complaint —
`effect@3.22.1` and `effect@4.0.0-rc.112` both land in the store and each
workspace links the one it declares. **Install-level isolation works. Type-level
isolation does not.**

`shared/crypto` alone on v4 produced **24 type errors**. Only 12 were real v4
migration work. The other 12 were one thing: `YieldWrap<Tag<Db, DbService>>` is
not a v4 `Effect`. `@osn/db` exports `Db` as a v3 `Context.Tag`, `shared/crypto`
yields it inside a v4 `Effect.gen`, and no edit inside `shared/crypto` can fix
that.

The bump had to walk the dependency chain to make it go away:

```
shared/crypto  →  @osn/db  →  @shared/db-utils
```

`@osn/db` passes its `Db` tag to `makeDbLive` / `makeD1DbLive` in
`@shared/db-utils`, whose signatures take `Context.Tag<any, A>`. With all three
on v4 — two `Context.Key` parameter types, one `Context.Service` declaration,
six `Effect.result` call sites — **`shared/crypto` type-checked clean and all 84
tests passed.**

But moving those two shared packages broke every other dependent, with the same
error class and for the same reason:

| Package | Errors |
| --- | ---: |
| `osn/api` | 192 |
| `pulse/api` | 29 |
| `zap/api` | 7 |
| `cire/api` | 7 |
| `pulse/db` | 5 |
| `zap/db` | 3 |
| `cire/host` | 0 — no Effect type surface |
| **Total** | **243** |

Every one is a v3 `Context.Tag` meeting a v4 `Layer` or `Effect`. There is no
subset of this repo that can sit on v4 while the rest sits on v3.

### The type-check passed and the test caught it

The most useful thing the spike produced is a worked example of the gate
argument on this page.

v3's `Effect.either` returns an `Either`, whose variants are tagged `"Right"`
and `"Left"`. v4's `Effect.result` returns a `Result`, tagged `"Success"` and
`"Failure"`. The ARC cache tests assert on the tag as a **string**:

```ts
expect(resA._tag).toBe("Right")   // v3
expect(resA._tag).toBe("Success") // v4
```

`toBe` takes `any`. Rename `Effect.either` → `Effect.result` and stop there, and
**the package type-checks clean while six assertions silently compare a v4 tag
against a v3 string** — every one of them now false. The compiler has nothing to
say. The test run fails immediately.

The skill's done condition would have called that migration finished. Our gate
does not, and this is why.

### Toolchain: no problems found

- **TypeScript 6.0.3**, `moduleResolution: "bundler"`, `strict: true` — v4's
  `.d.ts` resolve and check cleanly. v4 did **not** demand
  `exactOptionalPropertyTypes`.
- **`@effect/vitest@4.0.0-rc.112` on `vitest@4.1.11`** — peer satisfied, `it.effect`
  unchanged, 84/84 pass.
- **workerd bundling** — the Worker-safe `@shared/crypto/jwk` subpath plus
  `effect` v4 bundles under `--conditions=workerd,worker,browser` to 224 KB with
  **zero `node:` builtins**. No deploy-time module-eval hazard surfaced.
- **Soak rule** — rc.112 was 12 days old, well past `minimumReleaseAge`. No
  exclude needed, as predicted.

### Corrections to this page

- `Context.Tag` as a **type position** (a parameter annotation, not a
  declaration) maps to `Context.Key<I, S>`, per the reference's
  `Context.ReadonlyTag` → `Context.Key<Identifier, Shape>` entry. The page
  previously named only the declaration form.
- The class-syntax argument order flips: v3
  `Context.Tag(id)<Self, Shape>()` becomes v4
  `Context.Service<Self, Shape>()(id)`. Getting this backwards is the first
  thing to check when a service declaration will not compile.
- `Result` tag strings are `"Success"` / `"Failure"`. Any `_tag` compared as a
  string literal is invisible to the compiler — grep for them before phase 3.

## What phase 1 found

Landed 2026-09-06 as [#906](https://github.com/xchromo/osn/pull/906) into
`effect-v4`, closing #897 and #898 together.

**The red tree reaches the git hooks, not just CI.** `lefthook` runs oxlint on
staged files pre-commit and the type-check pre-push. Three of the files phase 1
had to touch for their `Context.Service` change also contain `Effect.catchAll`
and `Effect.either` — phase 2's work — so no staged set containing them can pass
the hook. **Phases 1 through 4 need `--no-verify` on both commit and push.**

Run `bun run fmt:check` separately and keep it passing, so only the lint half is
ever bypassed and only for errors the phase is not meant to fix. This is the
cost of the strategy the plan reasoned about at the CI level and missed at the
hook level.

**Two counts in this page were wrong**, corrected above: **14** packages declare
`effect` (not 13) and **11** declare `@effect/vitest` (not 10).

**`OpenAPI Freshness` is a runtime consumer, and the plan did not account for
it.** That CI job runs `openapi:generate` in `pulse/api` and `osn/api`, and
those generators *execute* the application code to produce the document. So it
does not merely fail to type-check — it crashes:

```
TypeError: Layer.scoped is not a function.
    at shared/redis/src/service.ts:36:58
```

Two consequences. First, it stays red until every **runtime-breaking** call is
gone — `Layer.scoped`, `Effect.catchAll` / `either`, the `Logger.*` set and the
`Schema.*` property accesses — so clearing type errors alone will not fix it.
Second, and the reason it is not a hidden regression: both generators crash
before writing, `git status shared/openapi/` stays clean, and **no committed
spec has drifted.** The check is failing on a crash, not on a diff.

The same reasoning applies to anything else that executes app code mid-stack.
There is nothing else in CI that does, but a new job that did would behave the
same way.

**The docs branch has to land before phase 2.** `effect-v4` was cut from `main`,
so it carries none of this: not the installed skills, not the `.gitignore` entry
for `.repos/`, not the CODEOWNERS entries, not the changeset allowlist, not this
page. The missing `.gitignore` bit first — phase 1 staged two embedded git repos
by accident and had to duplicate the entry. That branch is green and docs-only,
so it can merge to `main` on its own; `effect-v4` then rebases and picks all of
it up, and the duplicated hunk resolves itself.

**Phase 1's own change verified clean.** 1112 errors remained afterwards and
**zero** involved `Context.Service` or `Context.Key`. Every one mapped to a later
phase, with counts matching this page's sizing tables: `catchAllDefect` 94,
`decodeUnknown` 75, `either` 70, `maxLength` 45, `catchAll` 39, `filter` 25,
`optionalWith` 22, `minLength` 19, `between` 18, `Logger.pretty` 11,
`Logger.replace` 11, one `ParseResult` import. The five packages whose only
Effect surface was the service key went green immediately — `@shared/db-utils`,
`@osn/db`, `@pulse/db`, `@zap/db`, `@cire/db` — with 296 tests passing across the
four that have suites.

## What phase 2 found

Landed 2026-09-06 as [#908](https://github.com/xchromo/osn/pull/908), closing #899.

**A package with zero Effect imports can still be broken by this migration, and
the plan had no way to see it.** The sizing here counts files that *import*
`Schema`: 58 of them, in six packages. It never counted packages that merely
*depend* on those and blow up at module load.

`@osn/ui` and `@osn/social` import Effect nowhere. Both depend on `@osn/client`,
whose `src/tokens.ts:87` calls `Schema.Record({ key, value })` — v4 takes them
as two positional arguments, so the call throws while the module is still being
evaluated:

```
TypeError: undefined is not an object (evaluating 'value.ast')
  at effect/src/Schema.ts:3965
  at osn/client/src/tokens.ts:87
```

Their test suites cannot run at all until that one line is fixed. In `@osn/social`
it takes down 10 of 19 test files; in `@osn/ui`, one.

Two consequences worth carrying into the Schema phases:

- **`osn/client/src/tokens.ts` is the highest-leverage file in the whole
  migration.** One signature fix unblocks three test suites, two of which are
  not otherwise part of this work. Do it first in [[#Phase order|phase 4]].
- **A package's Effect surface is not the measure of its exposure.** Anything
  downstream of a package mid-migration is exposed too, and only at runtime —
  a type-check of `@osn/ui` says nothing about it.

**CI's own test run is the honest inventory**, not a local one. `bun run build`
fails locally in a sandbox on `fonts.google.com` (`@cire/landing`), which stops
turbo before the tests; CI has network and gets through. On #908's head CI ran
**1223 passing tests** with nine packages failing — `@cire/api`, `@osn/api`,
`@osn/client`, `@osn/social`, `@osn/ui`, `@pulse/api`, `@shared/email`,
`@shared/observability`, `@zap/api` — every one traceable to a `Schema.*` or
`Logger.*` call evaluated at import time. A local `bun run test` reproduces the
same nine once the build is out of the way.

## Phase order

> [!warning] Rewritten after the spike — there is no green intermediate state
> The original plan had eight phases, each a stacked PR that "leaves the tree
> type-checking". **The spike disproved the premise.** Effect's types cross every
> workspace boundary here, so the tree is red from the first version bump until
> the last call site is migrated. Phases are still the right *review* unit; they
> are not independently mergeable — which is why the whole migration runs on the
> `effect-v4` integration branch. See [[#Merge strategy: the `effect-v4` integration branch]].

Tracked as [#895](https://github.com/xchromo/osn/issues/895).

| # | Phase | Issue | Green on its own? |
| ---: | --- | --- | --- |
| 0 | Spike on `shared/crypto` | #896 | Done — findings above |
| 1 | Every `effect` version bump + all 13 `Context.Tag` → `Context.Service`, in one commit | #897 + #898 → [#906](https://github.com/xchromo/osn/pull/906) | ✅ merged red, as designed |
| 2 | Renames, removals, `ManagedRuntime`, `Runtime` | #899 | No |
| 3 | Logging + `@effect/opentelemetry` renames | #900 | No |
| 4 | `Schema` — the 20 files outside cire-api | #901 | No |
| 5 | `Schema` — cire-api's 38 files | #902 | **Yes — first green point** |
| 6 | Full sweep, dev-tier smoke, docs | #903 | Yes |

**Phases 1 and 2 of the old plan are now one phase.** They cannot be separated:
a version bump with the tags left on `Context.Tag` does not type-check anywhere,
and converting the tags without the version bump does not either. #897 and #898
stay as separate issues because they are separate bodies of work to review, but
they land together.

The tree is red from the start of phase 1 until phase 5 completes. That is a
property of the migration, not a mistake in the sequencing.

### Merge strategy: the `effect-v4` integration branch

`main` requires a PR and CI, and phases 1–4 cannot pass CI. **Decided
2026-09-06: a long-lived integration branch.** It is the only option that keeps
both a reviewable, phase-sized diff and an always-green `main`. The two
alternatives considered — one PR reviewed commit-by-commit, and waiving the CI
gate on a stack merging straight to `main` — were rejected for giving up one or
the other.

**`effect-v4` exists**, cut from `main` at `851df71`.

```
main ──────────────────────────────────────────────► (one green PR at the end)
  └── effect-v4 ◄── phase 1 ◄── phase 2 ◄── … ◄── phase 6
```

- **Every phase PR bases on `effect-v4`**, never on `main`:
  `gh pr create --base effect-v4`. Follow [[stacked-prs]] for the rest —
  `git config branch.<name>.gh-merge-base effect-v4` at worktree creation is
  what fixes the diff GitHub shows.
- **Phases 1–4 will show red CI on their PRs, by design.** `ci.yml` runs on
  every `pull_request` regardless of base, and the tree does not type-check
  until phase 5. Merge them into `effect-v4` anyway, with the red understood —
  and never by enabling auto-merge, which would be waiting on a check that
  cannot go green. Phase 5 is the first PR whose CI can pass.
- **Rebase `effect-v4` onto `main` regularly**, at minimum whenever `main`
  takes a change to a package the migration touches. The longer the branch
  lives the worse a deferred rebase gets, and every Effect-typed package is in
  scope, so "does this conflict?" is rarely no.
- **The final merge to `main` is one PR from `effect-v4`**, green, with the
  full suite, both D1 tiers and the dev-tier smoke behind it (#903).

Three things this branch deliberately does **not** trigger, all verified
against the workflows on 2026-09-06:

| Workflow | Trigger | Effect on `effect-v4` |
| --- | --- | --- |
| `deploy.yml` | `push` to `main` only | **No deploy.** Nothing reaches the dev tier until the final merge |
| `release.yml` | `push` to `main` only | **No version bump.** Changesets accumulate on the branch and are consumed once, when it lands |
| `changeset-check.yml` | `pull_request`, no branch filter | Runs on every phase PR, as intended — the filter was already removed for stacked PRs |
| `ci.yml` | `push` to `main`, plus every `pull_request` | Runs on every phase PR. Red until phase 5 |

So each phase still carries its own changeset, and the whole migration's
version bump happens in a single release when `effect-v4` merges.

### Rules for the execution

- **Run the skill, every phase.** Look each symbol up in the reference as you
  reach it. The tables above are sizing, not authority.
- **A clean `bun run check` is the floor, never the gate.** Effect's types are
  structural: a `Layer` that dropped its finalizer, a logger set that lost
  `tracerLogger`, a filter that lost its bound, a `_tag` compared against a v3
  string — all type-check. The spike hit the last of those for real; see
  [[#The type-check passed and the test caught it]]. The tests are what catch
  them, which is why they gate here even though the skill does not gate on them.
- **Phases 1–4 cannot be verified by CI**, because the tree is red until phase 5.
  Five checks go red and stay red: `Type Check`, `Lint & Format`, `Build & Test`,
  `OpenAPI Freshness`, and the `CI` rollup that aggregates them.
  Verify each one by the error count falling and by the packages that *are*
  fully migrated passing their own tests — not by a green suite that cannot
  exist yet.
- **`shared/*` changes run the full monorepo suite** once the tree is green
  again, per the Workers-debugging rule in `CLAUDE.md`.
- **Hold the production approval until the final phase.** A merge to `main`
  auto-deploys dev; production waits on a human. See [[dev-environment]].
- **Base every phase PR on `effect-v4`, never `main`.** `gh pr create --base effect-v4`.
- **Phases 1–4 need `--no-verify` on commit and push.** The lefthook pre-commit
  lint and pre-push type-check cannot pass on a half-migrated tree. Run
  `bun run fmt:check` by hand and keep it green, so only the lint half is
  bypassed and only for errors the phase is not meant to fix.
- **One changeset per phase.** `@cire/*` is version-less and must not share a
  changeset with versioned packages. They accumulate on the branch and are
  consumed in a single release when it merges.
- **Rebase `effect-v4` onto `main` regularly** — every Effect-typed package is
  in scope, so conflicts are the norm, not the exception.
- **Pin exact versions while v4 is pre-GA**, so no install moves the target
  mid-stack.
