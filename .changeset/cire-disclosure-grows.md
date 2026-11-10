---
"@cire/ui": minor
"@cire/host": patch
"@cire/invites": patch
---

`Disclosure` grows open: the box rises from its summary row to its full height while the body fades in and drops 4px, all on the app's `--dur-slow` and `--ease-out`, and a nested one grows the box round it on the same frames. The body is clipped only while it grows. It still closes at once, opens at once under reduced motion, and opens at once with the fade alone in an engine without `interpolate-size` (Safari, Firefox). The host's disclosure test and the guest site's reduced-motion test read the opening frame by frame.
