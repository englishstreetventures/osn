---
"@cire/theme": patch
"@cire/invites": patch
---

Derive contrast-corrected toast tokens from an invite's palette.

`--color-error` and `--color-success` are walked against `card`
(`--color-surface`), but a toast paints on `--color-surface-raised`, which is
derived as `card ± 0.05` lightness and sits outside that walk. Re-using the page
tokens on a toast therefore had no contrast guarantee — and on the built-in
**jewel** preset `--color-success` measures **4.29:1** against the raised surface,
under the 4.5 WCAG text minimum. Every jewel invite that raised an RSVP
confirmation was rendering a sub-threshold green.

`derivePalette` now also emits `--toast-surface`, `--toast-ink`, `--toast-border`,
`--toast-error` and `--toast-success`, identical in hue and chroma to the page's
pair but walked against the surface the toast actually sits on. A scheme that
already works gets its colours back untouched. The tokens ride the existing
allow-list, so they reach the guest document through the same injection gate as
every other palette variable.
