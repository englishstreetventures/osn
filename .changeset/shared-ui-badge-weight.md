---
"@shared/design-tokens": minor
"@shared/ui": minor
"@tools/lab": patch
"@pulse/web": patch
---

A title weight in the token contract, and `Badge` reads it.

- `@shared/design-tokens`: new role token `--ui-weight-title`, the weight a shared part sets a short title or a tag in, read through the utility `font-ui-title` (`--font-weight-ui-title` in `@theme inline`). It falls back to 600. `CONTRACT_SCALAR_TOKENS.fontWeight` lists it, and the agrees test fails if `tokens.css` does not alias it. The README's contract table gains it, with the `field` and `sheet` radius roles it was missing.
- `@shared/ui`: `Badge`'s label reads `font-ui-title` in place of `font-semibold`, so an app sets its weight once with `--ui-weight-title`. No app maps it, so every badge still draws at 600. `Badge`'s props refuse `innerHTML`, `innerText` and `textContent` (`SafeProps`). `Badge` carries no focus classes: a label takes no focus, so it draws no ring and removes no outline. A frozen snapshot of the unmapped badge's computed style, written before the change, holds pulse's look.
- `@tools/lab`: `Badges` shows both treatments and gains a treatment control; new `BadgeWeights` shows every badge unmapped and under `--ui-weight-title: 500`, captioned with the computed weight. The theming story's unmapped column also clears the weight token.
- `@pulse/web`: the token-contract browser test checks pulse's three badges compute 600 under its own stylesheet.
