---
"@cire/api": patch
---

The registry contribute route checks the guest's session before its per-IP
limiter, the one route that does. A caller with no claimed session gets 401
and spends none of the address's 20 a minute, so on venue wifi only claimed
guests use up the room's budget. Every other per-IP limiter still answers
first.
