---
"@osn/client": patch
"@osn/ui": patch
---

Backtick the scoped package names that had wrapped to the start of a doc-comment line.

A doc comment reads `@simplewebauthn/browser` at the start of a line as a tag named `@simplewebauthn`, so three comments that were describing a package were parsed as declaring an unknown tag. Backticking is the fix and was already the surrounding style — the same comments backtick `navigator.credentials.create` and `startRegistration` a few words earlier.

Nothing about the prose changes. What changes is that `jsdoc/check-tag-names` can now run at `error` with no false positives, which is what makes the closed tag set in `wiki/conventions/code-comments.md` a gate rather than a preference: the rule denies any tag it does not recognise, so every TSDoc-only spelling and anything invented is rejected at lint time.
