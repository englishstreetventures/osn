---
"@tools/e2e": patch
---

`musubi-org-detail` now measures and shoots the surfaces its pages draw from shared parts (`tests/support/musubi-surfaces.ts`): the create and edit dialogs' padded bodies and footers, the organisations list's rows on `Card` in both themes and under the pointer, a member's name at title size and the role `Chip`'s shape, a search result's name and the rail field's height, and, after its token and profile checks, `/authorize`'s dead-end box on `Card`, with screenshots at 390px and 1440px in light and dark. `musubi-passkey` checks the signed-out note's Sign in (outside the live region, opening the dialog and taking focus back when it closes), names the profile switcher, reads Settings' profile name and the consent screen's "Verified by Musubi" line, and finds the shell's own Sign in in the rail or top bar. Neither flow spends a sign-in more.
