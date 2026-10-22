---
"@cire/invites": patch
---

Mobile Safari: the invite guest site draws its top and bottom edge colours behind the status bar and toolbar, on devices with a safe-area inset. The invite shells opt into `viewport-fit=cover`, the hero marks its root for the edge logic, and the scroll cue sits above the bottom strip.
