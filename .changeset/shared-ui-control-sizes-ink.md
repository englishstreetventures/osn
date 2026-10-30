---
"@shared/ui": minor
---

`Input`, `Textarea` and `Select` gain three sizes and a fill. `form` and `form-compact` are 34px, with `md`'s and `sm`'s sides and type; `touch` is a guest's field, 46px with 16px type on a phone and 44px from 640px. `fill="ink"` draws the edge and fill from the text colour at 55% and 4.5%, focuses with the house outline and keeps 16px type below 640px, for a field on a surface the page does not choose. `Input` gains the `claim` face (an invitation's code: centred capitals) and the `amount` face (centred).

`Input` and `Select` take a fixed height at every size, so no field's height comes from the platform's font: a `Select` is now 28px at `sm` and 36px at `md`. `Select` draws its own chevron, 12px or 10px in from the right edge, with the value clear of it; its `class`, `classList`, `style` and `hidden` go on a box round it that places and sizes the field. With no fill, every class string at `sm` and `md` is unchanged.
