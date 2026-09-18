---
"@shared/ui": patch
"@musubi/social": patch
"@pulse/web": patch
---

Raw Tailwind palette colours become theme tokens, and two of them were failing contrast

`@shadcn/lint`'s `no-raw-colors` is the rule that makes the token contract
enforceable rather than aspirational, and it cannot go to `error` while these
exist. Fixing them first is the prerequisite, not the cleanup.

`musubi/social` and `pulse/web` gain `--color-success` and `--color-warn`. Both
values already existed as `--toast-accent-*`, contrast-checked and dark-mode
aware; what was missing was a *utility*, which is why nine call sites reached
for `text-green-600`, `bg-emerald-500` and `border-amber-500/40` instead. A raw
palette colour is fixed sRGB and does not move when the theme flips.

Two of them were live defects rather than only inconsistencies. Against pulse's
background, `text-green-600` measures **3.08:1** — below the 4.5:1 floor WCAG 2.2
SC 1.4.3 sets for text — and the `bg-emerald-500` "open now" dot measures
**2.36:1**, below the 3:1 floor SC 1.4.11 sets for a non-text indicator. The
tokens read 5.38:1 to 10.09:1.

*Measured 2026-09-17 — `contrastRatio` from `@shared/color`, each value against
`--background` in both themes.*

In `@shared/ui`, `OtpInput`'s red/green/blue borders and two auth views become
contract tokens, and ten `border-border` / `bg-border` in the primitives become
`border-ui-hairline`. An app-vocabulary name inside a library package is the
thing the contract exists to stop; every app happens to define `--color-border`
today, so this was a latent break rather than a live one.
