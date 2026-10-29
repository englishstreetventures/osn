---
"@cire/vendor": patch
"@cire/host": patch
"@cire/invites": patch
---

- `@cire/vendor`: the account avatar image is requested with no `Referer`.
- `@cire/host`: the account avatar image in the top bar is requested with no `Referer`, as a co-host's face already is.
- `@cire/invites`: the guest site's account avatar is drawn only from an `https:` URL; any other URL draws the initial.
