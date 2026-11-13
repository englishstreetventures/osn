---
"@shared/design-tokens": minor
"@shared/ui": patch
"@tools/lab": patch
"@musubi/social": patch
---

`Dialog` takes its shadow, its scrim and its sheet corners from the design-token contract.

- `@shared/design-tokens` adds a scrim role, `--ui-scrim` (`bg-ui-scrim`), in its own `scrim` group of `CONTRACT_COLOR_TOKENS`. It sits in no contrast pair, so no app has to map it; unmapped it is black at 50%.
- `DialogContent` casts `--ui-elev-2`, as `Modal` and a raised `Card` do, instead of Tailwind's `shadow-xl`. Musubi and pulse map no elevation, so their dialogs now cast `0 8px 24px rgb(0 0 0 / 0.12)`.
- `DialogOverlay` and `Modal`'s `::backdrop` both paint `--ui-scrim`. Musubi's and pulse's dialog scrims paint the same pixels as before (black at 50%).
- The sheet presentation keeps square bottom corners at every width below `md`; between 640px and 767px they were round.
- The lab's colour story shows the new role, and its cire mapping carries cire's scrim.
- Musubi's `DESIGN.md` records the elevation and scrim it leaves unmapped.
