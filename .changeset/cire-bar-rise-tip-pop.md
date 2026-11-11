---
"@cire/host": patch
---

The events and guests editors' unsaved-changes bar now rises from the window's
foot by its own height when the first edit of a run mounts it (`bar-rise`,
`@starting-style` and a `translate` transition on `--dur-slow`), and still
leaves at once. An icon's tooltip (`ActionTip`) that opened after a mouse
rested on its control scales in and fades from that control's side
(`tip-pop`, the menus' `menu-pop-in` on `--dur-base`); a keyboard open and the
next tip in a run still show at once. Both are cut to nothing under reduced
motion. `cire/host/DESIGN.md` §4 states both and the rungs chosen.
