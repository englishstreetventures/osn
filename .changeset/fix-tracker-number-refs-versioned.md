---
"@osn/api": patch
"@osn/social": patch
"@pulse/api": patch
"@osn/landing": patch
"@pulse/landing": patch
---

Rewrite every private-tracker comment reference in these packages to state the durable constraint directly (xchromo/osn#924's highest-priority batch).

A comment citing `osn-tracker#N` (or the shorter `tracker#N` spelling, also found live and now caught by `house/no-tracker-ref-in-comment` too) means nothing to a reader who cannot open the private tracker, and stops resolving once the finding closes — this repo is public, the tracker is not, so the number was a disclosure as well as a dead end. Every citation is now the fact it stood for: which D1 bind-parameter cap a query respects and why, which cookie-scoping attack a `__Host-` prefix defeats, which reflow guard a `resize-none` textarea keeps sound, why a response is never cached. One citation (`#130`) is to a finding that is still **open** — its replacement states the constraint as a live rule rather than implying a fix that hasn't happened, and links nothing.

Nineteen of the twenty tracker issues behind these citations are closed and fixed; none of that fix history is repeated here — only the fact that survives it. No behavior changed anywhere in this changeset: every edit is comment text.

Every rewrite was independently adversarially verified against the real diff and the current code (not the original finding's problem description) before being accepted; two of thirty-seven were caught wrong on the first pass — one a factual overstatement carried over from the finding's language rather than the code as implemented, one a bare `#N` left behind by an earlier pass — and both were corrected.
