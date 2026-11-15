---
"@osn/api": patch
"@osn/client": patch
---

`POST /profiles/delete` answers with `default_profile_id`, the account's default profile once the deleted one is gone; when the deleted profile was the default, or the account had none, the oldest remaining profile becomes the default. `@osn/client` names a profile in every `POST /token` grant from a page that holds an account: deleting the active profile makes active a profile the page holds a token for, or else that default, and an answer that names none leaves the deleted profile active, whose next grant is refused. New export: `decodeDeleteProfileResponse`.
