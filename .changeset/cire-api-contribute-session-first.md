---
"@cire/api": patch
---

The registry contribute route checks the guest's session before its per-IP
limiter, the one route that does. A request with no live guest session gets
401 and spends none of the address's 20 a minute; only requests carrying a
session, of any wedding's household, use up the room's budget. Every other
per-IP limiter still answers first.
