---
"@cire/ui": patch
"@cire/host": patch
"@cire/vendor": patch
---

In the light theme the chosen glass in every segmented strip, every chosen `glass` pill, and the invite builder's place pill and its chevron on a phone, now wear a 1px ring in readable gold at 80%, so the chosen choice stands 3.6:1 apart from its track instead of about 1.3:1. The ring is a new portal token, `--glass-ring`, which `@cire/ui`'s glass reads with the old hairline as its fallback. The dark theme keeps its hairline at 0.5px and looks the same as before.
