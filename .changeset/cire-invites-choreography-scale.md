---
"@cire/invites": patch
---

The bloom fill on Respond, the tick drawn behind it and the hero scroll cue's entry and drift now run on the site's motion tokens and follow `--motion-scale`. The tick and the cue's fade run on `--ease-out` and the cue's drift on `--ease-in-out`, in place of the browser's keyword curves; the fill already ran on `--ease-out`. Every one of their times, and the hold that ends the tick's draw, is multiplied by `--motion-scale`, so slowing the site to judge motion frame by frame slows these with everything else. At the default scale nothing changes in length. `motionScale()` moves from the unlock reveal into `src/lib/motion-scale.ts`, which both read.
