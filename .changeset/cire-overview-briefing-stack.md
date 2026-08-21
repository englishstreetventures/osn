---
"@cire/host": patch
---

Overview: stack the home top-down — the agenda band first, the module cards
beneath it.

The home was split down the middle at wide panel widths: "What's next" held a
fixed 20–26rem left column and the six module snapshots filled the rest. It
read lopsided — one list down one side, a block of cards down the other — and
the two halves ran to different depths, so the page ended in a ragged step.

The agenda now runs full width as a band across the top and the cards sit under
it in the same intrinsic `auto-grid` they already used. That gives the home one
reading order — what needs attention, then how each module is tracking — and
leaves a slot at the top of the band for the written summary that will lead it.

Full width was the reason the agenda was put in a column in the first place: six
dated rows across 1300px is a date on the left, a figure on the right, and a
hole in the middle. So the rows themselves now wrap into columns — two at a
panel width of 48rem, three at 72rem — which fills the band and halves its
depth. Order stays chronological, read left-to-right along each row.

The rules between rows moved from `divide-y` on the list to `border-t` on each
row. `divide-y` follows DOM order, which in a wrapped grid draws its lines down
the middle of the layout rather than between the rows you can see.
