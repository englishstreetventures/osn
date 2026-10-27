---
"@cire/host": minor
"@tools/e2e": patch
---

Organisers can collapse the module rail to its icons and back, from a toggle at its foot, and the browser remembers the choice.

- `@cire/host`: collapsed, the rail is 2.625rem and the panel takes the width it gives up; no icon or row moves. Each row keeps its label as its accessible name and shows it, with the module's hint, in a tooltip on hover after 300ms or at once on keyboard focus. A locked row's tooltip names the tier, and its card opens on a press only: the collapsed rail has no three-second dwell. The choice lives in `localStorage` under `cire.host.rail`, read before the first paint, so a collapsed page never slides on load. The phone's sheet ignores it. The sticky rail now sticks below the sticky top bar, where its first rows used to slide under the bar once the page scrolled.
- `@tools/e2e`: `cire-checklist-starter` collapses the rail, reads a row's label from the keyboard, reloads to find the rail still collapsed with no slide on load, opens the locked Vendors card from the narrow rail and expands it again.
