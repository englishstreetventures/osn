---
"@cire/theme": patch
"@cire/web": patch
---

RSVP confirmation: darken the success green and move the tick after the
"Respond" label.

`--color-success` on the dark built-in scheme moved from `oklch(72% 0.1421
146.94)` to `oklch(64% 0.1421 146.94)` — same hue and chroma, just a deeper,
less neon green for the RSVP button's fill sweep and the permanent tick.
`semantic()` in `@cire/theme` gained an optional `darkStart` override (default
unchanged at 0.72, still walked through `ensureContrast` so every scheme stays
legible) so only success shifted, not error. `cire/web/src/styles/global.css`'s
static fallback was updated to match, keeping the lockstep test (T-S1) green.

On the event card, the tick in the "Respond" button now renders after the
label instead of before it.
