---
"@tools/oxlint-house": patch
---

`house/no-tracker-ref-in-comment` now catches every spelling of a private-tracker reference, not only `osn-tracker#N`.

The pattern is `\b(?:osn-)?tracker[ \t]*#\d+`, case-insensitive: both the `osn-` prefix and the space before the `#` are optional, so `osn-tracker#98`, `tracker#98`, `osn-tracker #98`, `tracker #98` and `Tracker #98` all report.

Each variant was found live only *after* a narrower pattern had shipped and the tree had been declared clean. The bare `tracker#N` spelling surfaced first — 35 occurrences across `osn/api`, all invisible to the original `osn-tracker#N` pattern. Widening for that then left the spaced forms still hiding, and they turned out to be 22 more occurrences across 15 files (`#98`, `#287`, `#388`, `#454`, `#616`–`#619`, `#635`) in packages the earlier passes had reported as fully clean. Verified against the full tree before widening again: every match is a genuine private-issue citation, no false positives.

Two of those occurrences were not comments at all, so no comment-scoped rule would ever have caught them — a runtime error message shown to anyone who trips the `motion` SSR stub, and an `::error::` annotation printed into CI logs on every violation of the Astro test-route guard. Both are fixed in this changeset's sibling packages; the rule cannot police string literals and is not being asked to.

A **bare `#N` is still deliberately not matched**, and the rule now says why in its own source: that shape is an ordinary public cross-reference, and flagging it would fire on healthy comments. The consequence is a trap worth naming — dropping only the word `tracker` from a reference silences the rule while leaving a number that resolves to an unrelated issue in the public repo, so the edit looks clean and quietly invents a wrong cross-reference. A rewrite therefore removes the whole reference, never just its prefix.

Mutation-tested rather than only run to green: the space allowance was reverted, the new fixture confirmed to fail, then restored.
