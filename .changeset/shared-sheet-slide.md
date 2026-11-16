---
"@shared/design-tokens": minor
"@shared/ui": minor
"@musubi/social": patch
"@pulse/web": patch
"@osn/auth-ui": patch
"@tools/lab": patch
---

A `Dialog` sheet slides. Below `md`, `DialogContent presentation="sheet"` rises from its own height below the bottom edge over `--ui-dur-slow` and falls back over `--ui-dur-base`, both on the new `--ui-ease-sheet` token (`cubic-bezier(0.32, 0.72, 0, 1)`), at full opacity and unscaled, with its scrim fading on the same pace; closed part-way up or reopened part-way down it turns round from where it is. It moves by CSS transitions through two new utilities, `animate-sheet-in` and `animate-sheet-out`, beside two keyframes that move nothing and tell Kobalte how long to keep a closing sheet mounted. Under reduced motion it does not slide: it fades in and out with its scrim, in place, on the same pace and curve, with no transform on any frame; a new `sheet-hidden` utility holds where a sheet starts and ends, its own height below the edge or, under reduced motion, in place and transparent. At `md` and up, and with `presentation="centred"`, nothing changes. `DialogOverlay` takes the same optional `presentation`. Every sheet changes with it: Musubi's dialogs below `md`, `@osn/auth-ui`'s step-up, "Generate a new set?" and "Create a new profile", and pulse's share sheet. Musubi's, pulse's and `@osn/auth-ui`'s design documents say so; the lab adds a `DialogSheetSlide` story and lists the new curve.
