---
"@cire/host": patch
---

Load the command palette on demand, and move its ⌘K binding out of it

The palette is the one piece of portal chrome nobody sees until they ask for it,
so it no longer ships in the chunk that paints the page. It is fetched on first
summon, warmed while the browser is idle, and kept mounted afterwards.

The shortcut had to move out first: it was registered in the palette's own
`onMount`, so a lazy palette would have hidden the keystroke that fetches it
inside the thing being fetched. It now lives in `lib/command-shortcut`, bound
from first paint, and its tests moved with it.
