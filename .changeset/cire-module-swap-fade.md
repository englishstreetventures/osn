---
"@cire/host": patch
---

A view a module or sub-tab change mounts now fades in over the panel's held frame, on `--dur-base` with `--ease-out`, while the panel's height moves as before; so does a view taking over from its `Suspense` fallback. Only the view fades: the states a view swaps inside itself, such as the run sheet's loading row giving way to the day, arrive at once. The page's first view never fades, the invite builder (kept mounted across its four views) is never re-faded, and under reduced motion the new view arrives at once. `cire/host/DESIGN.md` §1 and §4 say so.
