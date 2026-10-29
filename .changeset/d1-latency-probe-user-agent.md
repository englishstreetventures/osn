---
"@cire/api": patch
---

The D1 latency probe sends the smoke check's user agent (`CI_USER_AGENT` in `scripts/smoke-check.ts`) on both of its requests, since Cloudflare's Bot Fight Mode challenges Bun's own user agent from a GitHub runner.
