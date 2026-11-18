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
  - "[[d1-limits]]"
  - "[[design-tokens]]"
last-reviewed: 2026-11-12
---

# House lint rules

`tools/oxlint/house` (`@tools/oxlint-house`) holds the lint rules this repository needs and nobody publishes. It is an ordinary workspace — formatted, linted, typechecked and tested like any other — and `oxlintrc.json` loads it as the `house` plugin. A rule this repository needs but nobody publishes belongs here. `tools/oxlint/anti-slop` beside it is a different thing: a verbatim upstream copy, covered in [[agent-tooling]].

Each rule's own source file holds the full reasoning and the bug that prompted it. This page is the index.

| Rule                              | Level                                                 | Catches                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-in-operator-key-guard`        | error                                                 | A type guard that narrows to `keyof typeof MAP` using `key in MAP`                                                                                                                |
| `no-module-scope-process-env`     | error, `cire/api/src/**` only (`src/local.ts` exempt) | A `process.env` read that runs while a Worker module loads                                                                                                                        |
| `no-non-subscribing-store-read`   | error, `cire/**/*-store.ts` only                      | A tracked read of an organiser cache that registers no dependency                                                                                                                 |
| `no-base-variant-at-call-site`    | error                                                 | A `base:` utility passed to one of our components from its call site                                                                                                              |
| `no-stacked-doc-block`            | error                                                 | Two or more doc blocks in front of one declaration                                                                                                                                |
| `no-tracker-ref-in-comment`       | warn                                                  | A tracker issue, finding tag, phase code or history in a comment — see [[code-comments]]                                                                                          |
| `no-unbounded-in-array`           | error                                                 | An `inArray` or `notInArray` list whose length the source does not fix — one D1 parameter per element                                                                             |
| `no-sequential-independent-await` | error, `**/src/**` only                               | Two adjacent awaited reads (`get*`, `find*`, `list*`, `load*` ...) where the second does not use the first's result — start both and wait once with `Promise.all` or `Effect.all` |
| `no-serial-effect-concurrency`    | error, `**/src/**` only                               | `{ concurrency: 1 }` on an Effect batch — items run one at a time; suppress with the reason when the order is the point                                                           |
| `no-literal-motion`               | error, product `src/**` only                          | A written duration, delay or easing where a motion token belongs, and `transition: all` — see §Literal motion below; `.css` and `.astro` files are checked by a script |

## Suppressing a house rule

A house rule is suppressed on the line it reports, with a reason after `--`:

```ts
// oxlint-disable-next-line house/no-unbounded-in-array -- at most 50 ids: one page, its limit clamped to 50 in routes/vendor-directory.ts
.where(inArray(directoryVendorCategories.directoryVendorId, ids))
```

The reason states the fact that makes the reported code safe and where the code enforces it, so a reader can check it without the rule.

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

## Per-element `IN` lists

drizzle's `inArray(column, list)` and `notInArray` bind one parameter per element of a JavaScript array. D1 refuses a statement with more than 100 bound parameters and `bun:sqlite` allows 999, so a list that outgrows the cap passes every test tier but the Miniflare one and fails only in production. [[d1-limits]] holds the numbers and the history.

The rule reports the list argument of any `inArray` or `notInArray` imported from `drizzle-orm` unless the source fixes how many parameters it binds:

| Passes                                                                                                                                                                 | Why                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `jsonEachIn(ids)` imported from `@shared/db-utils`                                                                                                                     | One bound JSON parameter, however long the list                                                          |
| A chain that starts with `.select(`, `.selectDistinct(` or `.selectDistinctOn(` and calls only builder steps after it (`.from(`, `.where(`, a join, `.limit(`, `.as(`) | A subquery binds no list. A chain that runs the query first — `.all().map(…)`, `.then(…)` — is reported  |
| An array literal, spreading only a same-file `as const` tuple                                                                                                          | Its length is written in the source                                                                      |
| A `sql` template                                                                                                                                                       | Judged as written, unless it interpolates `sql.join(…)` over anything but an array literal, at any depth |
| A same-file `const` bound to one of the above, or to an `as const` tuple                                                                                               | The same value under a name; a plain `const ids = []` can still be pushed to, so it does not pass        |
| A call to a same-file `const` arrow function whose expression body passes                                                                                              | A helper that returns a subquery                                                                         |

The rule follows a name through at most four `const` bindings or helpers. Everything else is reported: a parameter, a `let`, `body.ids`, `[...set]`, `[...map.keys()]`, any other call. Convert the list with `jsonEachIn`. Suppress instead only when a cap the code enforces keeps the whole statement under 100 parameters, and name that cap in the reason — a `safeLimit` slice, a clamped page size, a closed set of constants such as the paid tiers. A list bound twice in one statement, as in an `or` over both columns of an edge, counts twice.

The rule cannot see a list built in another module, an array interpolated into a `sql` template by name, or a namespace import (`drizzle.inArray`). It does not cover the multi-row `.values(rows)` insert, which reaches the cap at one parameter per column per row; that rule waits on englishstreetventures/osn#1450.

## Literal motion

A motion takes its duration, delay and curve from a token chosen by its job: the shared `--ui-dur-*` and `--ui-ease-*` ([[design-tokens]] §Motion), or an app's own, as cire's `--dur-*` and `--ease-*`. A number written where it is used follows none of them. Cire's ladder shortens at a desk, and a written `200ms` keeps the touch pace there ([[frontend-patterns]] §Motion follows the input).

It runs in two halves that share one matcher, [scripts/lib/motion-literals.ts](../../scripts/lib/motion-literals.ts), so they cannot disagree:

| Half | Reads | Runs in |
| ---- | ----- | ------- |
| `house/no-literal-motion` | `.ts`, `.tsx`, `.js` under `osn/*/src`, `musubi/*/src`, `pulse/*/src`, `cire/*/src`, `shared/*/src`, `zap/*/src`: class strings, style objects, `x.style.transition = …`, injected stylesheets in strings | `bun run lint`, locally and in CI |
| [scripts/check-motion-literals.ts](../../scripts/check-motion-literals.ts) | `.css` files, and `.astro` `<style>` blocks, markup classes, quoted `style` attributes, and classes in the frontmatter and `<script>`, under the same trees | `bun run scripts/check-motion-literals.ts` locally; CI's `script-tests` job, and its tests in `bun run test:scripts` |

oxlint never parses `.css`, and `oxlintrc.json` ignores `*.astro` (oxlint would read only an Astro file's frontmatter and `<script>`), which is why the second half exists. `bun run lint` does not run the script, so a literal in a stylesheet passes it and fails CI; run the script before you push a style change.

**What it reports.** In a `transition`, `animation` or one of their duration, delay, timing-function or property longhands, matched without regard to case or a vendor prefix (`-webkit-transition`), once every `var(…)` is set aside: a non-zero time, a written easing (`ease`, `ease-out`, `linear`, `cubic-bezier(…)`, `steps(…)`, `linear(…)`), and `all` in `transition` or `transition-property`. Among Tailwind classes: `duration-<n>` and `delay-<n>`, `ease-linear`, `transition-all`, an arbitrary value with a literal inside (`duration-[300ms]`, `animate-[spin_1s_linear_infinite]`, `[transition:opacity_200ms]`), and a named easing that reads Tailwind's stock curve (below).

**Tailwind's named easings.** `ease-in`, `ease-out` and `ease-in-out` read the theme's `--ease-in`, `--ease-out` and `--ease-in-out`. Every cire app sets `--ease-out` and `--ease-in-out` to cire's curves, so under `cire/*/src` those two pass. No other app sets any of them, and no app sets `--ease-in`, so everywhere else they compile to Tailwind's stock curves (`ease-out` is `cubic-bezier(0, 0, 0.2, 1)`, not `--ui-ease-out`) and are reported; write `ease-(--ui-ease-out)` or `ease-(--ui-ease-in-out)`. The file's path decides which.

**What passes.** A token's fallback (`var(--ui-dur-fast, 120ms)`); cire's scaled form, `calc(2.6s * var(--motion-scale))`; anything inside `@media (prefers-reduced-motion: reduce)` or behind `motion-reduce:`; a zero time; a custom property, which is a token's definition; and every named `animate-*`, which reads the theme's `--animate-*`. A query that negates or lists, such as `not (prefers-reduced-motion: reduce)` or `(prefers-reduced-motion: reduce), (min-width: 0)`, can match where motion is on, so nothing inside it passes; nor does anything under `motion-safe:` or `(prefers-reduced-motion: no-preference)`.

**Keeping a literal.** Replace a literal with the token of its job, even when the value moves: a hover takes `--ui-dur-fast` whether it was written 150ms or 160ms. Keep one only where no token's job fits it: a loop, a stagger, choreography slower than the ladder's longest step, or a time shared with script. A number is never the reason. A kept literal stays with its reason, in the form its file takes:

| Where | Form |
| ----- | ---- |
| A declaration in a stylesheet, an Astro `<style>` or a quoted `style` attribute | `/* motion-literal: <reason> */` inside the declaration, on the line above it, or after its `;` on the same line. It keeps that declaration and no other |
| Anything in `.ts`, `.tsx` or `.js`: a class string, a style object, a CSS string | `// oxlint-disable-next-line house/no-literal-motion -- <reason>` on the line above. It keeps every report on that line, so in a CSS string with several motion declarations, put `/* motion-literal: <reason> */` in the one declaration instead |
| A class in Astro markup | `{/* motion-literal: <reason> */}` straight before the tag. Astro drops the comment from the page |
| A class string in an Astro file's frontmatter or `<script>` | `// motion-literal: <reason>` (or `/* … */`) on the line directly above the line that holds the class |

A marker with no reason keeps nothing. In a string that ships to the page, such as `Modal`'s injected stylesheet, keep the in-string reason to a short tag and write the full reason in a code comment beside it. The rule does not read JavaScript animation options (`element.animate()`'s `{ duration: 350 }`), Tailwind's bare `transition` and `transition-colors`, which run its default 150ms, or a `style={…}` expression in Astro markup, where only a quoted `style` attribute is read — englishstreetventures/osn#2104 covers the first two.
