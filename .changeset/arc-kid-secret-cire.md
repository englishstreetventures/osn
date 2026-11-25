---
"@cire/api": minor
"@cire/infra": patch
---

cire-api checks osn-api's ARC key ids with `OSN_ARC_KID_SECRET` when it holds it: the account deletion's preview and erasure and the account export refuse, before any fetch of osn-api's keys, a token whose key id carries no MAC that verifies under it, and look a key up only by the part of the key id that MAC covers. Unset, no key id is checked, as before; set but under 32 characters, it is treated as unset and logged once per app build, never with the value. cire-api never holds `INTERNAL_SERVICE_SECRET`.
