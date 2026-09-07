---
"@tools/oxlint-house": patch
---

`house/no-tracker-ref-in-comment` now also catches the bare `tracker#N` spelling, not only `osn-tracker#N`.

Found live while rewriting the tracker-number batch for xchromo/osn#924: 35 occurrences across `osn/api` used the shorter spelling, all invisible to the rule's original pattern. Verified against the full tree before widening: the seven issue numbers involved (`#346`, `#446`, `#466`–`#469`, `#473`) are the only matches, no false positives.
