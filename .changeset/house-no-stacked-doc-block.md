---
"@tools/oxlint-house": patch
---

Add `house/no-stacked-doc-block`, an oxlint rule that fails a declaration with more than one doc block in front of it.

Only the last block is attached. The earlier ones document nothing, an editor shows the reader the wrong text on hover, and whatever the first block was really describing has quietly lost its comment — which is how `osn/api/src/lib/arc-middleware.ts` ends up with a block naming `requireArc` sitting on a different function.

The rule reads the comments before a declaration through `sourceCode.getCommentsBefore` rather than measuring line gaps, so a blank line between two blocks is treated as the same defect it is. A block opening the file is exempt: that one documents the module, not whatever declaration follows it. Reports once per declaration and counts the blocks in the message.

64 sites across 62 files today — 18 with no gap at all, 46 separated only by blank lines, four of them in auth code. It ships at `warn` for that reason and goes to `error` once the list is clear. The count was arrived at twice, once by the rule and once by an independent line-based scan, and the two agree.

`jsdoc/check-tag-names` moves from `off` to `error` with `typed: true`, which is what turns the closed tag set in `wiki/conventions/code-comments.md` into a gate: the rule denies any tag it does not recognise, covering every TSDoc-only spelling (`@remarks`, `@defaultValue`, `@typeParam`, `@inheritDoc`, `@packageDocumentation`, `@alpha`, `@beta`) and anything invented. It does not reject the classic-JSDoc spellings — `@example`, `@throws`, `@internal`, `@since`, `@public`, `@override` all pass — so keeping those out stays a convention a reviewer enforces. `typed: true` additionally rejects tags duplicating what TypeScript states, and was measured to add no diagnostics of its own.
