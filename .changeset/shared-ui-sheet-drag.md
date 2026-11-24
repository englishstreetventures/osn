---
"@shared/ui": minor
"@osn/auth-ui": patch
"@musubi/social": patch
"@tools/lab": patch
---

A `Dialog` sheet below `md` can be dragged down by its title row, or by its body once scrolled to the top, to close it. It follows the finger, its scrim fading with it; let go past a quarter of its height or after a flick it closes through `onOpenChange(false)` on a no-bounce spring started at the finger's speed, and otherwise springs back. Under reduced motion it still follows the finger and fades once let go. `DialogContent` takes `dismissible`, which refuses the drag, Escape and a press outside while false; the step-up sheet, the profile switcher and the delete-organisation confirmation pass it while their call runs. The rubber band and the spring move to `@shared/ui/lib/spring`. The lab gains a `DialogSheetDrag` story.
