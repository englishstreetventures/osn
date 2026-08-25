---
"@osn/api": patch
---

Tracker#466–470 — added `Cache-Control` to every authenticated response that
was missing one: `no-store` on `/token` and `/recovery/generate`, and
`private, no-store` on the per-user reads (sessions, passkeys, profile list,
account-deletion status, the graph routes, the recommendation routes). Set as
the first statement of each handler, above the rate-limit and auth checks, so
a 401 or 429 carries the header too, not just a 200.

`/recovery/status` already set `no-store`, but only after its DB read, inside
a `try` — so a rejection never got it. Moved the existing assignment up
rather than adding a second one.
