---
"@cire/api": patch
---

Pin the rate limit on claiming a directory listing. `POST /api/vendor/claims/:token/consume` already sits behind the vendor portal's per-IP limiter (20 requests a minute); two tests now prove a limited request answers 429 before the org check, the token burn or any claim statement runs, and that a cookie-signed request pays only its session read.
