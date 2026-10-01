---
title: House lint rules
description: The oxlint rules this repository writes for itself in tools/oxlint/house, what each one catches, and the rule of code each enforces
tags: [convention, lint, tooling]
related:
  - "[[code-comments]]"
  - "[[component-library]]"
  - "[[frontend-patterns]]"
  - "[[testing-patterns]]"
  - "[[backend-patterns]]"
last-reviewed: 2026-09-30
---

# House lint rules

`tools/oxlint/house` (`@tools/oxlint-house`) holds the lint rules this repository needs and nobody publishes. It is an ordinary workspace — formatted, linted, typechecked and tested like any other — and `oxlintrc.json` loads it as the `house` plugin. A rule this repository needs but nobody publishes belongs here. `tools/oxlint/anti-slop` beside it is a different thing: a verbatim upstream copy, covered in [[agent-tooling]].

Each rule's own source file holds the full reasoning and the bug that prompted it. This page is the index.

| Rule | Level | Catches |
|---|---|---|
| `no-in-operator-key-guard` | error | A type guard that narrows to `keyof typeof MAP` using `key in MAP` |
| `no-module-scope-process-env` | error, `cire/api/src/**` only (`src/local.ts` exempt) | A `process.env` read that runs while a Worker module loads |
| `no-non-subscribing-store-read` | error, `cire/**/*-store.ts` only | A tracked read of an organiser cache that registers no dependency |
| `no-base-variant-at-call-site` | error | A `base:` utility passed to one of our components from its call site |
| `no-stacked-doc-block` | error | Two or more doc blocks in front of one declaration |
| `no-tracker-ref-in-comment` | warn | A tracker issue, finding tag, phase code or history in a comment — see [[code-comments]] |

## Map-membership guards

A guard that narrows to `keyof typeof MAP` must test `Object.hasOwn(MAP, key)`, never `key in MAP`. `in` walks the prototype chain, so `constructor`, `toString` and `__proto__` pass, and the predicate then asserts that an inherited `Object.prototype` member is a real entry. The rule matches the narrowed parameter, not the literal `keyof typeof` text, so an aliased predicate is caught too. `cire/theme/src/palette.ts` shows the house form.

## Module-scope `process.env` in a Worker

On workerd, `nodejs_compat_populate_process_env` fills `process.env` on first access inside a request or cron handler, never while a module is being evaluated. A read at module scope therefore sees an empty object in every deployed tier and silently takes its fallback, and `wrangler deploy --dry-run` does not show it. The type checker cannot help: `@cloudflare/workers-types` declares `process` as `any`, and a dependency's declarations pull in `@types/node`.

The rule reports `process.env`, `process["env"]`, `globalThis.process.env` and `const { env } = process` outside any function. A function body, a default parameter and an instance class-field initialiser run later and pass; a static field or static block runs at load and is reported. An immediately invoked function at module scope also runs at load and is not caught. Read the handler's `env` binding, or read inside a function that runs per request, as `cire/api/src/observability.ts` does behind `Layer.suspend`.

It is on for the cire Worker only. The osn, pulse and zap Worker sources still hold module-scope reads (their `lib/jwks.ts`, `lib/outbound-arc.ts` and similar), so turning it on there waits on moving those reads first. See [[backend-patterns]].

## Non-subscribing store reads

In a cire organiser cache (`*-store.ts`), `entryFor(id).accessor()` is the subscribing read: it mints the cache entry, so a tracked read always has something to depend on. `cache.get(id)?.accessor()` does not mint it. When the entry is absent the read short-circuits before `accessor` runs, registers no dependency, and never re-runs once the entry appears.

The non-minting form is allowed only inside `peekCached*` and `hasCached*` functions — whether written as one `cache.get(id)?.accessor()` chain, or split across `const entry = cache.get(id)` and a later `entry?.accessor()` or guarded `entry.accessor()`.

## `base:` at a call site

A component's defaults use `base:` classes (`:where(&)`, zero specificity) so that a caller's **plain** utility wins. A caller that also writes `base:` ties on specificity, and the winner falls to the order Tailwind emitted the rules — visible nowhere at the call site. So a call site of one of our components (`@shared/ui`, `@osn/auth-ui`, `@cire/ui`, or a relative import) writes plain utilities. See [[component-library]].
