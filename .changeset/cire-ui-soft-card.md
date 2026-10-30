---
"@cire/ui": patch
---

`Card` takes the large corner. `CARD_BASE` swaps `base:rounded-ui-sm` for `base:rounded-ui-lg`, so cire's cards draw at the 16px card role once each app maps `--ui-radius-lg` to it. Until then an app's `lg` is 6px and its cards keep a small corner. Each card class string still carries exactly one `base:`-prefixed corner, so a caller's plain `rounded-*` still wins. An interactive card and `CardCta` fade only the text, background, border and underline colours, over the app's `--dur-fast` (200ms for an interactive card and 100ms for `CardCta` in an app that sets none), so a focused card's ring shows the moment focus lands rather than fading in; `CardCta`'s arrow nudges over `--dur-base` (200ms in an app that sets none). The exports are unchanged.
