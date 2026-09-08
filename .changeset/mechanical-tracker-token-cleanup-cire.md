---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/theme": patch
"@cire/vendor": patch
---

Clean up the `house/no-tracker-ref-in-comment` mechanical majority (xchromo/osn#924).

Every finding-tag, phase-code, and narrative-phrase reference flagged by the rule in a short comment block is now gone from these packages: a bare parenthetical tag deleted, a leading label stripped and the remainder capitalized into its own sentence, or a "used to be" narration rewritten forward to state the current, still-true fact. No behavior changes anywhere — every edit is comment text.

A handful of leftover `osn-tracker#N` citations that predated both this batch and the separate tracker-number-refs cleanup (xchromo/osn#930) are also gone from `@cire/host` and `@cire/vendor`, using the same treatment established there.
