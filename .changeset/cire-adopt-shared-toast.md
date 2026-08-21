---
"@cire/invites": patch
"@cire/host": patch
"@cire/vendor": patch
---

Adopt `@shared/toast` across the cire apps, and drop two workarounds with it.

The invite's toast no longer needs `!bg-surface-raised !text-text !border-border` — a row
of `!important` utilities that existed only to out-shout `solid-toast`'s inline defaults.
Colours come from the `--toast-*` custom properties `derivePalette` emits, so an invite's
toast is the organiser's palette with contrast already enforced against the surface it
sits on.

The layer also goes on as `class={Z_CLASS.TOAST}` again. It could not before:
`solid-toast` spread a hardcoded `z-index: 9999` onto the container's inline style, which
beat any class and parked the toast above the consent banner — so the layer had to be
passed as `containerStyle`. The new package sets no `z-index` at all.

A browser test now composites the painted toast on a 1×1 canvas and asserts both the
message and the tone glyph clear 4.5:1 against the surface they land on. It earned its
keep immediately, catching a missing token alias that would have shipped a 2.9:1 glyph on
the built-in evergreen scheme.
