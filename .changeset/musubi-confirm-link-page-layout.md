---
"@musubi/social": patch
---

A browser test renders `@osn/auth-ui`'s `ConfirmLinkPage` on a bare route under musubi's stylesheet and holds its layout: a long address leaves a 320px phone with nothing to scroll sideways and a 272px card, the one button is 44px tall below `md` and 40px from it, and the error notice sits directly above Try again. `DESIGN.md` gives the `h1` of a one-card bare route the title step, and a page's one full-width action 44px below `md`.
