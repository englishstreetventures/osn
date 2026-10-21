---
"@shared/toast": patch
---

Centred toasts (`top-center`, `bottom-center`) can use the whole viewport width. The container was placed at `left: 50%`, which left it only half the screen, so on a phone a toast with an action squeezed its message to a letter per line. It is now centred with auto margins.
