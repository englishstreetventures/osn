---
"@shared/ui": minor
---

Table cells get `align`, `tone` and `valign`, and stop colliding with the native attribute

`Th` and `Td` take alignment, a muted tone and vertical alignment as props. A
class override was never really an override: two Tailwind utilities on one CSS
property resolve by stylesheet order rather than by their order in `class`, so
`<Td class="text-right">` against the component's own `text-left` was a coin
flip. 21 such overrides in `cire/host` are props now.

Both types `Omit` the native `align` attribute rather than intersecting it.
`<td align>` is a deprecated attribute typed `"left" | "center" | "right"`, and
intersecting narrows the prop to the one value both unions share — so
`align="end"` failed with `Type '"end"' is not assignable to type '"center"'`,
which points nowhere near the cause. The same collision `Input`'s `size` has.

`Table` sets `font-ui-body` itself, which three call sites were adding by hand.
