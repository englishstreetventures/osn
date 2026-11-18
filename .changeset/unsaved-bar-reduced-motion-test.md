---
"@cire/host": patch
---

The unsaved-changes bar's browser test no longer counts frames under reduced motion. It reads the bar until the engine ends its transition, requires that transition, delay included, to take under a millisecond, and requires rest by the first frame after it ends, so a loaded CI runner that paints the start for a third frame no longer fails it. The check that no frame shows the bar partway is unchanged.
