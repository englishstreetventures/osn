---
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
"@cire/landing": patch
---

The four cire stylesheets stop generating `@shared/ui`'s `Dialog` classes, which no cire page draws (cire's dialogs are `Modal`), now that the shared `Dialog` carries a sticky header and a scroll-driven fade.
