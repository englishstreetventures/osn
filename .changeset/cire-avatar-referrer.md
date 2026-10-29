---
"@cire/vendor": patch
"@cire/host": patch
---

- `@cire/vendor`: the account avatar image is requested with no `Referer`.
- `@cire/host`: the account avatar image in the top bar is requested with no `Referer`, as a co-host's face already is.
