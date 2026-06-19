---
"@cire/organiser": minor
---

Replace the bare native `<input type="color">` in the invite builder's theme
section with an accessible popover colour picker that makes hex entry obvious.

A product-owner note ("nice, but I didn't realise at first how to input hex
codes") flagged that the native swatch hid hex entry. The new `ColorPicker`
(`cire/organiser/src/components/ColorPicker.tsx`, built on Kobalte 0.13.x colour
primitives) is a swatch trigger button — showing the current colour + its
`#RRGGBB` value, or "Default" — that opens a popover containing:

- a 2D saturation/brightness `ColorArea` and a `hue` `ColorSlider` for visual
  picking, and
- a clearly-labelled "Hex" `ColorField` front-and-centre so typing/pasting a hex
  code is the obvious path.

The visual picker and the hex field share one HSB `Color` value, so they stay in
sync; partial/invalid hex is never emitted upstream. The "Use default" reset is
preserved. The `onChange(string | null)` hex contract is unchanged — it still
emits a `#rrggbb` string (or `null`), so the live `ThemePreview` and the
`cire/api` colour allow-list keep working untouched. Styled with the existing
organiser theme tokens; keyboard-navigable via Kobalte's popover focus handling.

Adds `@kobalte/core` as a direct `@cire/organiser` dependency (already a
transitive dep via `@osn/ui`); `@internationalized/color` is not needed —
Kobalte bundles `parseColor`/`Color` under `@kobalte/core/colors`.
