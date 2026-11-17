---
"@tools/e2e": patch
---

The Musubi surfaces check that the sign-in dialog's and the step-up sheet's title row is sticky with no line and no fade under it at rest, and `animationsSettled` skips the scroll-driven fade under a dialog's title, which ends only when the dialog scrolls.
