---
"@cire/ui": patch
"@cire/invites": patch
---

`Button` actions are pills and their labels are sentence case. The corner leaves the shared base and is chosen once per variant and size: every action variant takes `rounded-ui-control`; `chip` takes `rounded-ui-pill`, so it stays round beside the event sheet's round close button whatever an app maps `control` to; `tile`, `field` and the `swatch` size take `rounded-ui-field`. Each class string carries exactly one corner, `base:`-prefixed, so a caller's plain `rounded-*` still wins. The boxed sizes drop `uppercase` and wide tracking for a medium weight at normal tracking, and the `sm`, `md` and `lg` side padding widens a step so the round ends sit balanced. The exports are unchanged. Until each app maps `--ui-radius-control` to a pill, its buttons keep their current corner and show sentence-case labels. In `@cire/invites`, the event card's browser test now measures the wrapped action row on a 320px phone: the narrower sentence-case labels fit side by side in the desktop card at every width.
