---
"@osn/social": patch
---

`MobileNav`'s column-count lookup now guards `GRID_COLS` with
`Object.hasOwn` instead of the `in` operator, so a polluted
`Object.prototype` can no longer redirect the fallback class through an
inherited property (tracker#491). Also adds test hygiene to `osn/api`'s OIDC
confusable-fold prototype-pollution test (tracker#493, T-S1 and T-S2): an
`afterEach` that clears
the polluted key on every exit path (not just the happy one), and a
pre-pollution baseline assertion so the post-pollution assertion is evidence
that pollution changed nothing.
