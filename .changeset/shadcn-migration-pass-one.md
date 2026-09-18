---
"@musubi/social": patch
"@musubi/landing": patch
"@osn/auth-ui": patch
"@shared/ui": patch
"@tools/lab": patch
"@tools/metrics": patch
---

First pass of the `@shadcn/lint` migration: 183 of 530 call sites cleared.

`no-arbitrary-values` sites move onto the contract's scales, and `no-restyle`
sites either drop a class the component already applies or switch to a variant
that already exists. Neither rule is at `error` yet — the remaining 347 sites
are in a second pass, and a rule goes to `error` only when its count is zero.

Where a `no-restyle` site genuinely needs a variant that does not exist, the
call site is left alone and the proposal recorded rather than guessed at. Those
land with the variant, not before.

One test changed. `ResponsiveDialogContent` was overriding `DialogContent`'s
radius with `rounded-card`, and `musubi/social/src/App.css` maps
`--ui-radius-lg: var(--radius-card)` — so the component's own default already
resolved to musubi's 16px and the override restated it. The wrapper drops it and
the test now asserts `rounded-ui-lg`, which is the class that has to keep
resolving to 16px for the two to stay equivalent.
