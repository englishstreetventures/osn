---
"@cire/ui": patch
---

`Button` actions are pills and their labels are sentence case. The corner leaves the shared base and is chosen once per variant and size: every action variant, `chip` included, takes `rounded-ui-control`; `tile`, `field` and the `swatch` size take `rounded-ui-field`. Each class string carries exactly one corner, `base:`-prefixed, so a caller's plain `rounded-*` still wins. The boxed sizes drop `uppercase` and wide tracking for a medium weight at normal tracking, and the `sm`, `md` and `lg` side padding widens a step so the round ends sit balanced. The exports are unchanged. Until each app maps `--ui-radius-control` to a pill, its buttons keep their current corner and show sentence-case labels.
