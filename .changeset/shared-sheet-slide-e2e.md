---
"@tools/e2e": patch
---

`musubi-passkey` holds the profile switcher, a sheet at 390 px, sliding: its own height below the bottom edge as it opens and part-way down half-way out, at full opacity and unscaled. `holdOverlay` pauses every animation and transition on a panel and its scrim together, catches a sheet's `ui-sheet-enter` and `ui-sheet-exit` runs, and reads how far the panel sits below the bottom edge and how tall it is.
