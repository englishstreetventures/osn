---
"@shared/ui": patch
---

`Button`, and anything wearing `buttonVariants`, hides its focus outline instead of removing it, so in a Windows contrast theme (forced colours), which drops the focus ring, keyboard focus draws a 2px outline. Outside a contrast theme nothing changes.
