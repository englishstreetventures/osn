---
"@cire/host": patch
---

The reorder settle test's reduced-motion case waits for the dropped row's shadow to finish its transition and read `none`, up to two seconds, instead of reading it one frame after the release. On a slow runner Chrome starts that 0.01ms transition a frame or more late, and the one-frame read saw the lifted shadow. The checks made in the release's own task, that no settle started, are unchanged. No component changes.
