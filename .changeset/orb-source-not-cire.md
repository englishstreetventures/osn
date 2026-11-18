---
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/vendor": patch
---

Leave `@shared/ui`'s new `orb.tsx` out of each site's Tailwind scan
(`@source not`), since no cire page draws the orb. Each stylesheet builds the
same CSS as before.
