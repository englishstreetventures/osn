---
"@osn/api": patch
"@osn/db": patch
---

In `@osn/api`, each Worker isolate writes its outbound ARC key after its first request, whatever the route, through `ctx.waitUntil`, and its replacement after the first request once that is due; every cron run whose deletion app settings parse does the same. A failed background write never reaches the answer and pauses background writes for a minute; a call to an app still writes the key before it signs when no write of it has started. A key lives four hours and is replaced after two. `GET /.well-known/arc-jwks.json` serves at most the newest 1,000 keys and warns from 500, and a call whose key has fallen outside them, or whose row was deleted, mints, writes and signs with a new one, or fails without signing; a key whose first write failed is dropped, so a key's expiry dates its first write. In `@osn/db`, the `arcOutboundKeys` comment says when the key is written.
