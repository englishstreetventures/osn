---
"@osn/api": patch
"@osn/client": patch
"@osn/db": patch
---

`POST /profiles/delete` answers with `default_profile_id`, the account's default profile once the deleted one is gone; when the deleted profile was the default, or the account had none, the oldest remaining profile becomes the default. A delete removes nothing when its profile is the account's last at the moment it writes, and an account keeps exactly one default whichever profile write lands first. `POST /token` refuses an empty or malformed `profile_id` as it refuses a profile the account does not own. `@osn/db` adds a partial unique index, `users_one_default_per_account`; its migration first leaves each account exactly one default, its oldest. `@osn/client` names a profile in every `POST /token` grant from a page that holds an account: deleting the active profile makes active a profile the page holds a token for, or else that default, and an answer that names none leaves the deleted profile active, whose next grant is refused. A token minted for a profile the page has deleted is not kept. New export: `decodeDeleteProfileResponse`.
