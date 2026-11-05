---
"@cire/api": patch
"@cire/envelope": patch
"@cire/host": patch
"@cire/infra": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
"@cire/vendor": patch
---

Stop exporting symbols used only inside their own file, and delete declarations nothing reads. No behaviour changes.
