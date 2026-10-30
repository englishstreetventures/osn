---
"@cire/ui": patch
"@cire/host": patch
---

`Button variant="choice"` stays legible while locked: with `aria-disabled` it keeps its look and only stops answering the pointer, where every other variant still fades to 40% (`disabled` still fades a choice too). Under the pointer an unchosen choice goes halfway to chosen — its edge and ink a mix of rest and chosen and a 30% accent ring — and its colours and ring move on `--dur-base`. The hover is gated on the option being neither chosen nor locked and keeps zero specificity, so a chosen radio keeps its ring and a caller's plain class still wins. The host's `DESIGN.md` says so.
