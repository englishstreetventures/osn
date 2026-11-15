---
"@osn/api": patch
"@osn/client": patch
---

`POST /token` mints for a named `profile_id` only when the session's account owns it, and answers any other named profile with `400 invalid_grant` before it mints or rotates anything; the client ends the session on that answer. A grant naming no profile mints for the default profile. `@osn/client` changes only comments.
