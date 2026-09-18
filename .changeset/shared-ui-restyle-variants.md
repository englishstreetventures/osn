---
"@shared/ui": patch
"@shared/design-tokens": patch
---

Give the shared primitives variants for the treatments call sites were spelling out by hand.

`Modal` and `DialogContent` take a `presentation`, so a bottom sheet is one
choice rather than an anchor, a radius, a pair of squared corners and a
safe-area inset that five call sites across three products had each spelled out
differently. The sheet's top radius reads a new `--ui-radius-sheet` token, which
defaults to `--ui-radius-lg` so an app can make that grip pronounced without
touching its cards.

Also: `Badge` gains an `eyebrow` treatment, `Label` a `tone` and `size`,
`Avatar` a `ring` for overlapping stacks, `Card` a `variant`/`elevation`/`radius`,
`PopoverContent` a `padding`, `DialogClose` a `glyph` treatment,
`DropdownMenuLabel` an `identity` tone, `TabsTrigger` a `size`, `Td` `code` and
`indent`, and `Input` a `face` for identifier fields.
