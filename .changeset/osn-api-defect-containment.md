---
"@osn/api": patch
---

Stop a defect carrying an allow-listed tag from reaching a client.

Effect v4 removed `FiberFailure`. `ManagedRuntime.runPromise` rejects with
`Cause.squash(cause)`, and `squash` returns the **defect object** when the cause
carries no `Fail` — where v3's `Cause.failureOption` returned `None` and the
helper answered `null`. A `Data.TaggedError` IS an `Error` carrying a `_tag`, so
`Effect.die`, `Effect.orDie` and a bare `throw` inside `Effect.sync` all put an
allow-listed tag straight in front of `makeSafeError`'s allowlist, which then
returns the defect's message. `Effect.orDie` is already an established pattern
here (`routes/graph.ts`, `recommendations.ts`, `organisation.ts`).

Nothing was leaking: every construction site of the three allow-listed tags uses
`Effect.fail`. But that is a convention with no enforcement, and the doc comments
asserted it as a structural guarantee. Now it is one.

`makeAppRunner` goes through `runPromiseExit` and inspects the `Exit`: a `Fail`
is rethrown via `Cause.findErrorOption` (unchanged for all 136 call sites, and
`run` keeps its `Promise<A>` signature), anything else becomes an `OpaqueDefect`
that deliberately carries no `_tag`. Both the shared-runtime and test-layer
branches funnel through the same path, so a test cannot observe error handling
the routes do not have.

`OpaqueDefect` exposes its `Cause` through a prototype getter over the native
non-enumerable `Error.cause`, not an own field: a constructor parameter property
is enumerable, and `JSON.stringify` would then serialise the whole `Cause` —
re-opening the leak through any structured logger that walks enumerable keys.
`JSON.stringify(defect)` is `{"name":"OpaqueDefect"}`.

`public-error.ts` needed no behaviour change but its comments were stale: the
`FiberFailure → Cause → Fail` justification is dead, and the symbol-key
rationale was wrong (v4 brands `Cause` with *string* keys). What `Reflect.ownKeys`
actually buys now is reaching the **non-enumerable** `Error.cause`, which is the
only route to a defect's `Cause` — pinned by a test.

Also fixes a latent flaw in both old test harnesses: `throw new Error("expected
rejection")` sat inside the `try`, so its own rejection became the value under
test and a generic-message assertion could pass vacuously.

osn/api: 1141 -> 1153.
