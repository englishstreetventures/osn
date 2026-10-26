---
"@tools/oxlint-house": patch
"@cire/host": patch
"@cire/vendor": patch
---

Pin the module-doc shape for a file whose line 1 holds a pragma, and use it in the two haptics tests (englishstreetventures/osn#928).

`house/no-stacked-doc-block` gains a fixture with a `// @vitest-environment` pragma on line 1, a module doc block, an `import`, then a declaration with its own doc block. The rule reports nothing for it, because it never reads the comments in front of an import. The rule itself is unchanged.

In `@cire/host` and `@cire/vendor`, `tests/lib/haptics.test.ts` had its module doc merged into the doc block of `load()`. The module doc now sits under the pragma and above the `import`, and `load()` keeps its own one-line doc. Comments only; no test or behaviour changed.
