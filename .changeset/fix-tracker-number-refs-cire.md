---
"@cire/api": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/vendor": patch
"@cire/landing": patch
---

Rewrite every private-tracker comment reference in these packages to state the durable constraint directly (xchromo/osn#924's highest-priority batch).

Same fix as the versioned-package changeset for this branch: a citation to a closed tracker finding is replaced with the fact it established — the `__Host-` cookie prefix rationale, the entitlement-check fold's actual shape, the auto-size reflow guard's width-only blind spot (that finding is still open; the comment states the constraint without implying a fix or naming the tracker). No behavior changed, every edit is comment text, every rewrite independently verified against the real diff.
