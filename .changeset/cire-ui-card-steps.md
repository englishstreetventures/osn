---
"@cire/ui": patch
"@cire/host": patch
---

`Card` and `cardClass` take a padding step, a fill and a `danger` tone, so a card that needs more room or no ground can ask for one instead of being drawn by hand.

- `padding`: `sm` (16px), `md` (20px, the default), `lg` (24px) and `xl` (32px).
- `fill`: `wash` (the surface at 30%, the default), `well` (the sunk surface), `opaque` (the surface) and `none`.
- `tone`: `default`, `accent` and `danger`, which changes the border alone.

Called with no options, both draw the card they drew before, so no screen changes here. `interactive` stays on `cardClass` alone and goes only with the wash fill and a tone other than `danger`; the type refuses the rest. The interactive card's fallback duration, used only where an app declares no motion ladder, is 100ms like every other part's.

The dietary pills and `Reveal` take their durations from the app's motion ladder (`--dur-fast` for a pill's colours, `--dur-base` for a block opening) instead of a fixed 200ms, so both follow the shorter ladder under a mouse or trackpad. A pill fades only its colours.

The host portal's design system (`DESIGN.md` §7) describes the new options.
