---
"@cire/host": minor
"@tools/e2e": patch
---

Organisers can collapse the module rail to its icons and back, from a toggle at its foot, and the browser remembers the choice.

- `@cire/host`: collapsed, the rail is 2.625rem and the panel takes the width it gives up; no icon or row moves, and each icon reads at 3:1 or more. The rail slides on a press only; a container width step lands at once. Each row keeps its label as its accessible name and shows it, with the module's hint, in a tooltip on hover after 300ms or at once on keyboard focus. A locked row's tooltip names the tier, and its card opens on a press only: the collapsed rail has no three-second dwell. The choice lives in `localStorage` under `cire.host.rail`, read before the first paint, so a collapsed page never slides on load. The phone's sheet ignores it. The sticky rail sticks below the sticky top bar, so its first rows stay in view however far the page scrolls.
- `@tools/e2e`: `cire-checklist-starter` collapses the rail, reads a row's label from the keyboard, reloads to find the rail still collapsed with no slide on load, opens the locked Vendors card from the narrow rail, expands it again and scrolls to check it sticks below the top bar. A focused row on the expanded rail shows no label.
