---
"@shared/design-tokens": minor
---

A contract token for the curve an overlay leaves on, `--ui-ease-exit`, and `animate-out` reads it. `Dialog`, `Popover` and the default `DropdownMenu` close on it; `animate-in` still reads `--ui-ease-out`. Its value is `cubic-bezier(0.22, 1, 0.36, 1)`, the same as `--ui-ease-out`, and no app sets either, so no overlay in any app changes how it moves. An app can now map `--ui-ease-out` onto its own arriving curve and its overlays still leave as before. `CONTRACT_SCALAR_TOKENS.motion` lists the new token, and the agreement test now also fails when `tokens.css` declares a root token the list leaves out.
