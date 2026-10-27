---
"@cire/api": patch
---

Adding a co-host asks osn-api whether the person and the owner adding them have blocked each other, either way round, and refuses such a person with the same 404 as an unknown handle (409 `already_host` when they already hold a seat). The add answers 503 when no block check is configured and 502 when osn-api cannot answer. The co-host autocomplete asks osn-api's handle search as the signed-in organiser, so it suggests no one with a block against them. Every osn-api call the add and the autocomplete make gives up after 5 seconds.
