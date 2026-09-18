---
"@shared/ui": patch
"@pulse/web": patch
---

A house lint rule for the `base:` tie, and the forty sites it found

`base:` compiles to `:where(&)` — zero specificity — so a component's defaults
lose to a caller's **plain** utility by design. A caller who writes `base:` too
ties with them, and the tie is resolved by the order Tailwind emitted the rules
in: not the class-attribute order, and nothing visible at the call site.

`house/no-base-variant-at-call-site` reports it, at `error`, with the count
already cleared to zero rather than tolerated.

The rule has two conditions and needs both. The tag must start upper-case — a
`base:` on a plain `<div>` is a component styling its own markup, which is the
entire point of the variant. And the component must be **ours**, resolved
through its import: `@shared/ui`, `@osn/auth-ui`, `@cire/ui`, or a relative path. A wrapper handing
`base:fixed` down to Kobalte's `Dialog.Overlay` is not a tie at all, because
Kobalte sets no `base:` defaults — that wrapper is declaring the zero-specificity
default its own consumer will override. Without the second condition the rule
reports 199 sites, essentially every component in the shared layers, and says nothing true about any
of them.

Forty real sites, all fixed here: `ShareEventButton` in pulse (23, including a
share dialog that was not the width it asked for), `InfoPopover`'s trigger, and
both `UsernameInput`s passing `base:flex-1` to an `Input` that has `base:`
defaults of its own.
