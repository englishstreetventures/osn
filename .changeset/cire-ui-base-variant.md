---
"@cire/ui": patch
---

`UsernameInput` stops passing a `base:` utility to `Input`, and `@tools/oxlint-house` gains the rule that found it

`base:flex-1` on a component whose own defaults are also `base:` is a tie, not
an override, and a tie resolves by Tailwind's stylesheet order rather than by
anything at the call site.

`house/no-base-variant-at-call-site` reports it at `error`. It resolves the
component through its import and only reports what is ours (`@shared/ui`, `@osn/auth-ui`,
`@cire/ui`, or a relative path), because a wrapper passing `base:` down to a
Kobalte primitive is not a tie at all — Kobalte sets no `base:` defaults, so the
wrapper is declaring the zero-specificity default its own consumer overrides.
