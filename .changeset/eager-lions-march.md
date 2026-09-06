---
"@osn/api": patch
"@osn/db": patch
"@pulse/api": patch
"@pulse/db": patch
"@shared/db-utils": patch
"@zap/api": patch
"@zap/db": patch
---

Take @cloudflare/workers-types 5.20260830.1 (from 4.20260702.1). This also fixes a peer range nobody had noticed: wrangler 4.127.1 declares an optional peer on `@cloudflare/workers-types` `^5.20260722.1`, which the old `^4.20260702.1` pin did not satisfy. Types only, no runtime change.
