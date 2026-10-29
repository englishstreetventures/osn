---
"@cire/ui": patch
"@cire/host": patch
---

`@cire/ui/disclosure` is new: `Disclosure`, a native `<details>` with a summary row, a marker that turns as it opens, and the opening fade, in two tones. `card` (the default) takes Card's box with the well fill and a leading `›` that turns a quarter; `nested` gives one set inside another box the small corner. `rule` draws a hairline under the row and a trailing `+` that turns into ×, for an FAQ. The marker is the readable gold and turns only with its own disclosure. The body fades in as it opens and closes at once, and does not fade for a reader who asked for less motion. `open`, `onToggle` and `onSummaryClick` cover a disclosure that opens itself and one that counts the reader's touch. `@cire/ui/card` gains `cardBoxClass`, a card's box without its padding. No screen uses the part yet; the apps' hand-written disclosures move onto it in a later change.

The host portal's design system (`DESIGN.md` §4 and §7) describes the part, and the host's browser tests check its fade, turns, ink and insets.
