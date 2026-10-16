---
"@pulse/api": patch
"@pulse/web": patch
---

`@pulse/api`: the local Bun server compiles routes ahead of time, so per-IP
rate limits see the client's address and no longer answer every session check,
discovery request and sign-in leg with 429. Workers keep AOT off.

`@pulse/web`: "Skip for now" on the welcome screen lands on the home feed
instead of bouncing back to `/welcome`.
