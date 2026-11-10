---
"@shared/ui": minor
---

`CardTitle` reads its weight from the design-token contract's title weight, `--ui-weight-title`, through `font-ui-title`, and falls back to 600, the `font-semibold` it carried before, as `DialogTitle` does. No app maps the token, so every card title draws exactly as before: a snapshot of the title's computed style written before the change still passes. Pulse imports `Card` but draws no `CardTitle`. An app whose house style stops at 500 maps the token once instead of passing a class to each title.
