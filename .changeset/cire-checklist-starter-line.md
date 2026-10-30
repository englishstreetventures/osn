---
"@cire/host": patch
"@cire/invites": patch
---

The host Checklist no longer draws a line across the top of its panel: the starter checklist's closed preview dialog lays out nothing (the fix is in `@shared/ui`'s `Modal`). The same fix stops the vendor directory's listing dialog and the invite builder's preview dialog laying out while closed, and gives the guest site's sheets back their entry transition. Browser tests pin the checklist and the sheet.
