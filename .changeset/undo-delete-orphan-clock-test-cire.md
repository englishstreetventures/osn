---
"@cire/host": patch
---

The undo-delete browser suite now checks, in one pass, that pressing Undo while it holds focus leaves no toast clock running behind it, so the next delete keeps its whole five-second window.
