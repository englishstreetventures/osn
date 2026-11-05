---
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
"@cire/api": patch
"@cire/ui": patch
"@tools/e2e": patch
---

Both portals draw `@cire/ui`'s parts for their chrome: the top bar's wordmark and its boot-bar copy, which now land in the same place; one sign-in page, "Cire · Host portal" and "Cire · Vendor portal" over a roman heading and the opaque card, which shows "Connecting to musubi…" after the press and resumes on the page a sign-in bounced someone off; and one avatar for the faces on a task, both account triggers and the guest site's account card. A declined or failed sign-in on a portal now lands on that portal's sign-in page with its notice, and a sign-out goes to a plain sign-in page.
