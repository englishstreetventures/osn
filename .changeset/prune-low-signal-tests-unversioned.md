---
"@cire/api": patch
"@cire/build-tools": patch
"@cire/host": patch
"@cire/invite-designs": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/theme": patch
"@cire/ui": patch
"@cire/vendor": patch
"@tools/pr-metrics": patch
---

Delete low-signal unit tests: constants asserted against themselves, mock echoes, valid-object schema acceptances with no edge, static render checks and duplicates. Tests only; no runtime change.
