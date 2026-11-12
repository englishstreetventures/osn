---
"@osn/api": minor
---

`@osn/api` counts every begin's first sign-up link against a per-mailbox window of ten an hour (`registrationFirstLinkCap`, keyed like the Resend cap, so every `+tag` and Gmail form of an address shares it); the mailbox's first link of the hour always goes, and a begin past the window answers as a mailed one with nothing sent. It replaces the restart window and its decline mark: a begin that carried `previous`, or that follows a decline, counts as every first link does.
