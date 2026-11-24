---
"@cire/api": patch
---

The Worker treats only an `OSN_ENV` of exactly `local` as a local run. Any other value, an absent one included, applies every deployed-tier check, and a Worker whose `OSN_ENV` names no tier logs an error saying so.
