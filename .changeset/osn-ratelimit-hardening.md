---
"@osn/api": minor
"@shared/rate-limit": minor
---

Rate-limit + IP-trust hardening for osn-api behind Cloudflare.

- **Client-IP trust (security fix):** the non-local Workers runtime now keys per-IP rate limiting on `cf-connecting-ip` exclusively (`trustCloudflare: true`), never the spoofable `x-forwarded-for`. This closes the bypass where an attacker forged XFF to rotate past the per-IP auth limits. Local Bun dev keeps socket-peer keying; `TRUSTED_PROXY_COUNT` is now ignored in deployed tiers. Unresolved IPs still deny (429), never bucket-share.
- **Native Workers rate limiting:** the 60-second-window per-IP auth limiters move off Upstash onto the Cloudflare Workers native Rate Limiting binding (global + atomic at the edge, fail-closed). The three 1-hour-window per-IP limiters (recovery generate/complete, email-change-begin), every per-user/per-account limiter, and every stateful store stay on Upstash. `createWorkersRateLimiter` + `WorkersRateLimitBinding` are now shared from `@shared/rate-limit`.
- **Workers observability:** `[observability]` enabled in `osn/api/wrangler.toml` (and every named env) so Workers Logs/invocations are captured in the Cloudflare dashboard.

Per-colo trade-off accepted: native rate limiting is counted per Cloudflare location, not globally. osn-api must be redeployed for the new bindings + observability to take effect.
