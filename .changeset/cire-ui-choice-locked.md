---
"@cire/ui": patch
"@cire/host": patch
"@cire/vendor": patch
---

`Button variant="choice"` stays legible while locked: with `aria-disabled` it keeps its look and only stops answering the pointer, where every other variant still fades to 40% (`disabled` still fades a choice too). The chosen option wears a 2px accent ring. Under the pointer an unchosen choice goes halfway to chosen — its edge and ink a mix of rest and chosen and a 1px 30% accent ring, so chosen and hovered differ by the ring's width and not by gold alone — and its colours and ring move on `--dur-base`. The hover is gated on the option being neither chosen nor locked and keeps zero specificity, so a chosen radio keeps its ring and a caller's plain class still wins.

`Button variant="outline"` answers the pointer with its edge alone: the edge turns full gold, nothing fills, and its gold word keeps 4.5:1 or more on the page, every card fill and the raised surface in both themes. The host's `DESIGN.md` says so.
