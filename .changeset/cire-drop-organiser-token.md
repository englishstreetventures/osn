---
"@cire/api": minor
"@cire/organiser": patch
---

Remove the interim X-Organiser-Token shared secret and the flat
/api/organiser/{guests,events} alias routes. Organiser auth is OSN
passkey JWT only; import flow now scopes to the caller's owned wedding
instead of the bootstrap hardcode.
