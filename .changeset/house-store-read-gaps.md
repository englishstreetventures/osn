---
"@tools/oxlint-house": patch
---

Close five review gaps in `house/no-non-subscribing-store-read`.

The rule matched only `cache.get(id)?.accessor()` written as one direct chain. It now also catches the same bug split across two statements — `const entry = cache.get(id)` followed by `entry?.accessor()`, or by a guarded `if (!entry) return; entry.accessor()` — which is the established idiom this codebase already reaches for once a reader does more than one thing (`patchCachedEvent` in `events-store.ts`). A zero-argument call is what tells that guarded read apart from a guarded setter call like `patchCachedEvent`'s own `entry.setEvents(...)`, so the setter path stays unflagged without naming it specially.

The exemption for `peekCached*`/`hasCached*` was a bare `startsWith` test on the nearest named function, so a local helper named `peekCachedRows` nested inside an unrelated function inherited the exemption, and the prefix alone couldn't tell a real `peekCachedTasks` from a coincidental `peekCachedTasksReactively`. It now requires the name to match `/^(peekCached|hasCached)[A-Z]/` and the function to be exported at module top level — reaching `Program` via an `ExportNamedDeclaration` without passing through another function first.

`boundName` (shared with `no-in-operator-key-guard`) now also derives a name from a class `MethodDefinition`/`PropertyDefinition`, so a `peekCachedTasks` written as a class method or field arrow is recognised instead of false-flagged.

`oxlintrc.json`'s override widened from `cire/host/src/lib/*-store.ts` — which missed nested paths and never matched at all against an absolute path — to `cire/**/*-store.ts`, now also covering `cire/vendor/src/lib/{enquiries,vendor}-store.ts`. Enabling the rule unscoped across the whole repo produces zero diagnostics; `cire/**` is chosen anyway to hold the blast radius to the one product whose organiser-cache convention it encodes.

The fixture suite now asserts `diagnostics.length` and the reported line for every broken fixture, not just the reported file set, and adds fixtures for both escapes above plus the shapes the rule deliberately still misses (an aliased `cache` identifier, a computed accessor) — each pinned with a comment stating whether it is expected to report.
