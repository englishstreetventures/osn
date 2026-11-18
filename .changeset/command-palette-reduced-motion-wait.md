---
"@cire/host": patch
---

The command palette's reduced-motion browser test waits for the engine to end both arrivals (`getAnimations()` empty) before it reads the panel at rest, instead of a fixed two frames, which a loaded runner can outlast. It now also bounds each arrival's end, delay included, at under 1ms on the engine's clock. Test only; the palette itself is unchanged.
