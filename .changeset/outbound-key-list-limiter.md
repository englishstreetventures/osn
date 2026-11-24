---
"@osn/api": patch
---

`GET /.well-known/arc-jwks.json` admits each caller's address (an IPv6 one by its /64) 30 times a minute and 60 an hour, and each configured app's fetch, which reaches osn-api from the address every Worker's cross-zone subrequest shares, under the app's zone instead. Past either budget, for an address that cannot be resolved, or while the coordination store fails, it answers 429 before reading any key. Each refusal is counted (`osn.arc.jwks.refused`, by lane and reason) and the first in each minute per lane is logged.
