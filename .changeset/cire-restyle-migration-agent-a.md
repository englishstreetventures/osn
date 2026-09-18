---
"@cire/ui": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
---

The four cire surfaces stop restyling shared components from outside

63 `shadcn/no-restyle` reports and 8 `shadcn/no-arbitrary-values` reports across
`@cire/host`, `@cire/invites` and `@cire/landing`, resolved by naming the design
rather than by suppressing the rule. Both are zero for `cire/`.

`@cire/ui`'s `Button` gains five variants and a size, each a treatment that
call sites were spelling by hand and disagreeing about:

- `choice` — one option among several, marked through `aria-pressed` **or**
  `aria-checked` so a toggle group and a radio group look the same. Four call
  sites had four different marks and two hand-rolled gold focus rings, which
  the shared base already draws from `--ui-focus`.
- `tile` — the control that *is* a block: a wedding card, a setup step, a
  collapsed section menu, the palette chip. Past a certain size a hairline
  stops describing a target. Four sites had picked `surface/30`, `surface/40`
  and `bg/30` between them.
- `quietDanger` — `bareDanger`'s reasoning for a worded action that needs a
  box. A column of red-outlined buttons down a table reads as an error state.
- `dashed` — the empty slot. A dashed box promises that something appears; a
  solid one promises that something happens.
- `touchLink` — `subtle` with the underline at rest rather than on hover, for
  `@cire/invites`, which is read on a phone where a hover-revealed underline
  never appears.
- `size="swatch"` — one hairline of padding for a control whose content is the
  picture, so the border frames it rather than boxing a label.

Three `Modal` call sites take `presentation` instead of a class list: the guest
sheet, the demo sheet and the events drawer. The consent dialog takes
`presentation="sheet" surface="ground"`, because its own category rows are
raised surfaces and a panel painted the same colour stops them reading as rows.
`@cire/invites` and `@cire/landing` map `--ui-radius-sheet` to the 28px grip
their sheets were writing as `rounded-t-[1.75rem]`.

The remaining arbitrary values become named theme entries — `--blur-scrim` and
`--text-glyph` in `@cire/host`, `--drop-shadow-pin` and `--blur-ground-shadow`
in `@cire/invites`. The two `before:content-['•']` warning lists become real
`<ul class="list-disc">` lists: a flex item is blockified and loses its
`::marker`, which is why the bullet was generated content in the first place,
and generated content is read out as content by some screen readers.
