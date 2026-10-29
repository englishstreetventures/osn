---
"@cire/api": patch
"@cire/landing": patch
"@tools/e2e": patch
---

The host and vendor privacy pages on cire's marketing site name Cloudflare as the provider that holds rate-limit state. Those pages and the privacy summary name Oceania as the primary region, where Cloudflare hosts the databases; the host and vendor pages add that Cloudflare keeps sign-in state there where it can and counts rate limits where a request arrives. A comment in cire-api and the end-to-end suite's comments and environment test name the coordination store, and the suite's sign-up retry flow waits for the refused send before it counts it.
