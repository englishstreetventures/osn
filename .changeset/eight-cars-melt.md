---
"@cire/api": patch
"@cire/host": patch
"@cire/vendor": patch
"@tools/oxlint-house": patch
---

Take oxlint and @oxlint/plugins 1.80.0 (from 1.78.0) and oxfmt 0.65.0 (from 0.62.0).

oxlint 1.80 newly errors on five sites in this tree, all of them fair:

- `cire/api/src/services/spreadsheet.ts` had a real, invisible U+FEFF sitting in the docblock that explains why an invisible U+FEFF breaks CSV imports. Replaced with a written-out escape sequence, which is what the comment meant to show.
- Four indirect `(0, eval)` calls across `cire/host/tests/lib/theme.test.ts` and `cire/vendor/tests/lib/theme.test.ts`, which deliberately execute the real inlined theme boot script. 1.78 only caught the direct form; 1.80 catches `(0, eval)` too. Each now carries the same `no-eval` disable comment a sibling site in the same file already had.

oxfmt 0.65 reformats nothing — 1435 files unchanged.
