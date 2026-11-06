---
"@shared/ui": minor
"@tools/lab": patch
---

`Field` takes `labelTreatment`, `"caps"` by default or `"plain"`. A field that
does not pass it draws exactly as before, so cire's forms do not change.

`plain` draws the label as `Label` draws it by default: the words as written,
full ink, weight 500, the control type step. The hint, the errors, the gaps and
the wiring (`id`, `aria-describedby`, `aria-invalid`) are the same in both, and
`labelHidden` wins over either.

`Field` now reads its `hint` once and holds it, so a hint written as JSX is
built once rather than on every read. The DOM it draws is unchanged.

The lab's `shared/ui/forms` gains `PlainLabels` and `FieldPlayground`.
