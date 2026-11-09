---
"@shared/design-tokens": minor
"@shared/ui": minor
"@musubi/social": patch
"@tools/lab": patch
---

Overlays leave faster and smaller than they arrive, and each motion token says what it is for. `tokens.css` adds `--ui-dur-exit` (80ms), `--ui-scale-enter` (0.96), `--ui-scale-exit` (0.98), `--ui-distance-enter` (24px) and `--ui-distance-exit` (8px), each with a one-line job comment, and `CONTRACT_SCALAR_TOKENS.motion` lists them. `animate-out` runs `--ui-dur-exit`; `zoom-in` and `zoom-out` replace `zoom-in-95` and `zoom-out-95` and read the scale tokens. Under `prefers-reduced-motion: reduce`, `animate-in` and `animate-out` run nothing: the old reduced-motion rule matched no overlay, so `Dialog`, `Popover` and the default `DropdownMenu` still moved.

In `@shared/ui`, `Dialog`, `Popover` and both `DropdownMenu` looks take their scale from the tokens; `Popover`, `Tooltip` and the default menu grow from their trigger. `Tooltip` opens after 400ms, goes at once with no exit (the pointer can still cross onto it), and a neighbour opened within 300ms of another closing carries `data-instant` and does not animate. `Modal` exits in 150ms by default (was 200ms), sinking 8px to 0.98 rather than 24px, and its backdrop fades out with it. Musubi's `DESIGN.md` names the shared overlay motion; the lab's motion story reads the new duration.
