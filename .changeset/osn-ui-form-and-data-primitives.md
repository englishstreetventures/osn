---
"@shared/ui": minor
---

Lift cire's `Field`, `Select`, `Meter` and `Table` into `@shared/ui`, on the token contract

The last of the primitives that existed twice in cire's two portals and nowhere
shared. `Field` is the label-hint-error scaffolding — it hands the caller `id`,
`aria-describedby` and `aria-invalid` through a function rather than rendering
the control itself, which is what keeps a hint a *description* instead of
silently becoming part of the input's accessible name. `Fieldset`, `Select`,
`Meter`, `meterPct`, `Table`, `Th` and `Td` come with it.

`Input` and `Textarea` now share one control box with `Select` (`ui/control`),
so the three line up in a column instead of being three near-misses, and all
three take `size` — `md` for a form, `sm` for a control inside a table row. The
prop omits the native `size` attribute rather than shadowing it, so passing a
character count is a compile error. `Textarea` gains `resize`, which a passed
`class="resize-none"` could not do reliably: both classes land on the element
and Tailwind resolves the conflict by stylesheet order, not attribute order.

Two off-contract values fixed along the way. `Input` and `Textarea` set a ring
offset from `--color-background`, which is not a contract token and resolves to
nothing outside the two apps that happen to declare it; `UsernameInput`'s
"available" message was a fixed `text-green-600` that does not follow the theme.
Both now read the contract. `UsernameInput` also extends `InputProps` rather
than the raw element props, so the `size` it forwards reaches the box it names.

Covered by 30 new tests in the real-Chromium tier — sizes that are genuinely
different sizes, an `aria-invalid` border a person can see, a label that reaches
its control, a rejected save that does not take the caret with it, a table that
scrolls under the keyboard, and a meter whose fill is transformed rather than
resized. Each primitive has a bench in `@tools/lab`.
