---
"@cire/landing": patch
---

Take the guest site's values for the four brand tokens that had drifted —
`--color-border`, `--color-error`, `--color-success` and `--color-surface-raised`.
`cire/invites` is the source of truth because its `@theme` literals are held in
lockstep with what `derivePalette(evergreen)` emits; the landing site's were typed
by hand and checked against nothing. `KNOWN_DIVERGENCES` is now empty.
