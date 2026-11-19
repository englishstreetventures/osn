---
"@shared/ui": minor
"@shared/design-tokens": minor
"@musubi/social": patch
"@osn/auth-ui": patch
"@pulse/web": patch
"@tools/lab": patch
---

A long `Dialog` keeps its title in view. The panel, sheet or card, is capped at 85% of the window at every width and scrolls; `DialogHeader` sticks to its top with no line under it, and a 16px fade from `--ui-surface` comes in under it over the first 16px of scroll on a CSS scroll timeline (whole from the first pixel under reduced motion). A browser without scroll timelines keeps the hairline. The panel's scroll padding follows the header's height, so a field reached with Shift+Tab arrives with its label clear of the header and the fade; a header taller than a third of the panel stops sticking; and focus the trap wraps onto a control out of view scrolls the panel to show it. Pulse's guest list takes the shared cap in place of its own. `tokens.css` adds `scroll-edge-timeline` and `scroll-edge-fade`. Musubi, `@osn/auth-ui` and pulse record it in their `DESIGN.md`; the lab adds a `DialogScrollEdge` story.
