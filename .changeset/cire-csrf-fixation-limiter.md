---
"@cire/api": minor
---

Harden cire/api auth defences (W5): CSRF Origin guard, fail-closed per-IP rate-limit keying, and a native Cloudflare Workers Rate Limiting backend.

- **Origin guard (S-L3):** new `cire/api/src/lib/origin-guard.ts` validates the `Origin` header on every state-changing method (POST/PUT/PATCH/DELETE) under `/api/*` against the same `WEB_ORIGIN`-derived allowlist CORS uses — 403 on missing/mismatch when an allowlist is configured, pass-through in dev. No ARC/S2S exemption (cire has no inbound S2S routes). Bounded `cire.origin_guard.rejections` metric.
- **IP hardening (C4):** `client-ip.ts` now keys the limiter on the trusted `cf-connecting-ip` header only — the spoofable `x-forwarded-for` fallback and the shared `"unknown"` bucket are removed. An unresolvable IP fails closed (429).
- **Workers Rate Limiting backend (C1/C4):** new `workers-rate-limiter.ts` wraps the native `ratelimit` binding behind the existing `RateLimiterBackend` interface (fail-closed on throw); `wrangler.toml` declares the `CLAIM_RATE_LIMITER` binding (5/60s). The claim endpoint uses it when the binding is present, falling back to the in-memory limiter for local dev/tests.
