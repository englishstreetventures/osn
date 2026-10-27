---
"@cire/api": patch
---

Adding a co-host asks osn-api whether the person and the owner adding them have blocked each other, either way round, and refuses such a person with the same 404 as an unknown handle (409 `already_host` when they already hold a seat). The add answers 503 when no block check is configured and 502 when osn-api cannot answer. Both osn-api calls on the add, the handle lookup and the block check, give up after 5 seconds.
