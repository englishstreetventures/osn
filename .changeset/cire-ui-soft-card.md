---
"@cire/ui": patch
---

`Card` takes the large corner. `CARD_BASE` swaps `base:rounded-ui-sm` for `base:rounded-ui-lg`, so cire's cards draw at the 16px card role once each app maps `--ui-radius-lg` to it. Until then an app's `lg` is 6px and its cards keep a small corner. Each card class string still carries exactly one `base:`-prefixed corner, so a caller's plain `rounded-*` still wins. The exports are unchanged.
