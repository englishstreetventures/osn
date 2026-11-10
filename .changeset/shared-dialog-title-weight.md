---
"@shared/design-tokens": minor
"@shared/ui": minor
"@pulse/web": patch
---

`DialogTitle` reads its weight from a new role token in the design-token contract, `--ui-weight-title`, through the utility `font-ui-title`, and falls back to 600, the `font-semibold` it carried before. No app maps the token, so pulse's three dialogs, Musubi's and the auth views draw their titles exactly as before; a snapshot of the title's computed style written before the change still passes, and pulse's browser tests check 600 under pulse's own stylesheet. An app whose house style stops at 500 maps the token once instead of passing a class to each title.

An app that wants its overlays to fade without scaling sets `--ui-scale-enter` and `--ui-scale-exit` to 1. Every Kobalte overlay then changes only its opacity; `Modal`'s exit scale stops too, while its rise and sink stay, and its entry keeps its own `scale(0.98)`, so it still grows as it opens. No component changed for this: the browser tests now prove it, and the design-token wiki page describes it. Default motion is unchanged.
